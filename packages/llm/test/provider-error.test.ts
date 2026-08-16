import { describe, expect, test } from "bun:test"
import { classifyProviderFailure, isContentPolicyViolation, isContextOverflow, isQuotaExceeded } from "../src"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
    expect(isContextOverflow("400 status code (no body)")).toBe(false)
  })

  test("separates exhausted quota from transient rate limits", () => {
    const quotas = [
      "Token Plan Person monthly quota limit exceeded",
      "insufficient_quota",
      "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。",
      "账户余额不足",
    ]
    const rateLimits = ["rate_limit_exceeded", "Too many requests", "resource exhausted; retry later"]

    expect(quotas.every(isQuotaExceeded)).toBe(true)
    expect(rateLimits.some(isQuotaExceeded)).toBe(false)
    expect(classifyProviderFailure({ type: "rate_limit_error", message: quotas[2] })).toEqual({
      kind: "quota",
      retryable: false,
    })
    expect(classifyProviderFailure({ code: "rate_limit_exceeded", message: "Slow down" })).toEqual({
      kind: "rate_limit",
      retryable: true,
    })
  })

  test("classifies permanent and transient provider stream failures consistently", () => {
    expect(classifyProviderFailure({ type: "authentication_error", message: "invalid API key" })).toEqual({
      kind: "authentication",
      retryable: false,
    })
    expect(classifyProviderFailure({ type: "server_error", message: "service unavailable" })).toEqual({
      kind: "provider_internal",
      retryable: true,
    })
    expect(classifyProviderFailure({ type: "api_error", message: "request timed out" })).toEqual({
      kind: "provider_internal",
      retryable: true,
    })
    expect(classifyProviderFailure({ type: "connection_error", message: "stream disconnected" })).toEqual({
      kind: "transport",
      retryable: true,
    })
    expect(classifyProviderFailure({ type: "invalid_request_error", message: "prompt is too long" })).toEqual({
      kind: "invalid_request",
      retryable: false,
      classification: "context-overflow",
    })
    expect(classifyProviderFailure({ type: "content_policy", message: "request rejected" })).toEqual({
      kind: "content_policy",
      retryable: false,
    })
    expect(isContentPolicyViolation("safety service temporarily unavailable")).toBe(false)
    expect(classifyProviderFailure({ type: "server_error", message: "safety service temporarily unavailable" })).toEqual({
      kind: "provider_internal",
      retryable: true,
    })
    expect(classifyProviderFailure({ message: "unclassified provider failure" })).toEqual({
      kind: "unknown",
      retryable: false,
    })
  })
})
