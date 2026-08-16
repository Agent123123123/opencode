import { Schema } from "effect"
import {
  AuthenticationReason,
  ContentPolicyReason,
  InvalidRequestReason,
  LLMError,
  ProviderErrorEvent,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
  type ProviderFailureKind,
} from "./schema"

const patterns = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

const exclusions = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

export const isContextOverflow = (message: string) =>
  !exclusions.some((pattern) => pattern.test(message)) &&
  patterns.some((pattern) => pattern.test(message))

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"

const quotaPatterns = [
  /(?:insufficient|exceeded|exhausted|reached)[-_\s]*(?:monthly[-_\s]*)?(?:token[-_\s]*)?quota/i,
  /(?:token[-_\s]*)?quota[-_\s]*(?:limit[-_\s]*)?(?:exceeded|exhausted|reached)/i,
  /insufficient[-_\s]*(?:credits?|balance|funds?)/i,
  /(?:billing|credit|usage)[-_\s]*(?:limit|quota)[-_\s]*(?:exceeded|exhausted|reached)/i,
  /(?:token[-_\s]*plan|usage|credit).{0,80}(?:limit reached|usage limit|exhausted)/i,
  /(?:token[-_\s]*plan|套餐|积分|额度).{0,80}(?:用量上限|额度不足|已用尽|已耗尽)/i,
  /(?:余额|配额|额度)不足/i,
]

export const isQuotaExceeded = (message: string) => quotaPatterns.some((pattern) => pattern.test(message))

export const isContentPolicyViolation = (message: string) =>
  /content[-_\s]?policy|content_filter|safety[-_\s]?(?:violation|filter|policy|block)/i.test(message)

export type ProviderFailureInput = {
  readonly type?: string | undefined
  readonly code?: string | undefined
  readonly message: string
  readonly retryable?: boolean | undefined
}

export const classifyProviderFailure = (
  input: ProviderFailureInput,
): {
  readonly kind: ProviderFailureKind
  readonly retryable: boolean
  readonly classification?: "context-overflow"
} => {
  const identity = [input.type, input.code, input.message].filter((value) => value !== undefined).join(" ")
  if (isContextOverflow(identity)) {
    return { kind: "invalid_request", retryable: false, classification: "context-overflow" }
  }
  if (isContentPolicyViolation(identity)) {
    return { kind: "content_policy", retryable: false }
  }
  if (
    /authentication|unauthori[sz]ed|invalid[-_\s]?api[-_\s]?key|permission[-_\s]?(?:denied|error)|forbidden|access[-_\s]?denied/i.test(
      identity,
    )
  ) {
    return { kind: "authentication", retryable: false }
  }
  if (isQuotaExceeded(identity) || /billing[-_\s]?error/i.test(identity)) {
    return { kind: "quota", retryable: false }
  }
  if (/rate[-_\s]?limit|too[-_\s]?many[-_\s]?requests|throttl|resource[-_\s]?exhausted/i.test(identity)) {
    return { kind: "rate_limit", retryable: input.retryable ?? true }
  }
  if (/connection[-_\s]?error|network[-_\s]?error|socket[-_\s]?error|stream[-_\s]?(?:disconnected|closed)/i.test(identity)) {
    return { kind: "transport", retryable: input.retryable ?? true }
  }
  if (
    /overload|api[-_\s]?error|internal[-_\s]?error|server[-_\s]?error|service[-_\s]?unavailable|model[-_\s]?stream[-_\s]?error|temporar|timeout/i.test(
      identity,
    )
  ) {
    return { kind: "provider_internal", retryable: input.retryable ?? true }
  }
  if (/invalid|bad[-_\s]?request|validation|not[-_\s]?found|unsupported/i.test(identity)) {
    return { kind: "invalid_request", retryable: false }
  }
  if (input.retryable === true) return { kind: "provider_internal", retryable: true }
  return { kind: "unknown", retryable: false }
}

/** Convert a provider-declared terminal stream event into ordinary typed turn failure truth. */
export const providerEventFailure = (event: ProviderErrorEvent) => {
  const reason = (() => {
    if (event.classification === "context-overflow") {
      return new InvalidRequestReason({
        message: event.message,
        classification: event.classification,
        providerMetadata: event.providerMetadata,
      })
    }
    if (event.kind === "authentication") {
      return new AuthenticationReason({
        message: event.message,
        kind: "unknown",
        providerMetadata: event.providerMetadata,
      })
    }
    if (event.kind === "quota") {
      return new QuotaExceededReason({ message: event.message, providerMetadata: event.providerMetadata })
    }
    if (event.kind === "rate_limit") {
      return new RateLimitReason({
        message: event.message,
        providerMetadata: event.providerMetadata,
        canRetry: event.retryable,
      })
    }
    if (event.kind === "provider_internal") {
      return new ProviderInternalReason({
        message: event.message,
        providerMetadata: event.providerMetadata,
        canRetry: event.retryable,
      })
    }
    if (event.kind === "transport") {
      return new TransportReason({ message: event.message, kind: "network", canRetry: event.retryable })
    }
    if (event.kind === "invalid_request") {
      return new InvalidRequestReason({
        message: event.message,
        classification: event.classification,
        providerMetadata: event.providerMetadata,
      })
    }
    if (event.kind === "content_policy") {
      return new ContentPolicyReason({ message: event.message, providerMetadata: event.providerMetadata })
    }
    if (event.retryable) {
      return new ProviderInternalReason({
        message: event.message,
        providerMetadata: event.providerMetadata,
        canRetry: true,
      })
    }
    return new UnknownProviderReason({ message: event.message, providerMetadata: event.providerMetadata })
  })()
  return new LLMError({
    module: "ProviderStream",
    method: "event",
    reason,
    attemptCount: 1,
    // Provider-declared stream errors cannot be replayed safely inside the
    // current stream. Hand the exact terminal fact to the owning Attempt.
    retryExhausted: event.retryable,
  })
}
