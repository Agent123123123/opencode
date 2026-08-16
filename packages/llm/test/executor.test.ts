import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Random, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Headers, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMError } from "../src"
import { LLMClient, RequestExecutor } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseRaw } from "./lib/sse"
import { it } from "./lib/effect"

const request = HttpClientRequest.post("https://provider.test/v1/chat?api_key=secret&key=secret&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer secret", "x-safe": "visible" })),
)

const secretRequest = HttpClientRequest.post("https://provider.test/v1/chat?api_key=query-secret-123&debug=1").pipe(
  HttpClientRequest.setHeaders(
    Headers.fromInput({
      authorization: "Bearer header-secret-456",
      "ChatGPT-Account-Id": "account-secret-789",
    }),
  ),
)

const responsesLayer = (responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const countedResponsesLayer = (attempts: Ref.Ref<number>, responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Ref.update(attempts, (value) => value + 1)
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const transportFailureLayer = (cause: unknown) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
          ),
        ),
      ),
    ),
  )

const randomMidpoint = {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
}

const expectLLMError = (error: unknown) => {
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  return error
}

const errorHttp = (error: LLMError) => ("http" in error.reason ? error.reason.http : undefined)

describe("RequestExecutor", () => {
  it.effect("preserves a safe response-header timeout code and reason", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(10_000)
      const error = yield* Fiber.join(fiber)

      expectLLMError(error)
      expect(error).toMatchObject({ retryable: true, attemptCount: 3, retryExhausted: true })
      expect(error.reason).toMatchObject({
        _tag: "Transport",
        kind: "timeout",
        code: "UND_ERR_HEADERS_TIMEOUT",
        message: "The provider did not send HTTP response headers before the transport deadline.",
      })
    }).pipe(
      Effect.provide(
        transportFailureLayer(Object.assign(new Error("headers timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" })),
      ),
    ),
  )

  it.effect("extracts a nested connection reset without exposing raw exception text", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(10_000)
      const error = yield* Fiber.join(fiber)

      expectLLMError(error)
      expect(error).toMatchObject({ retryable: true, attemptCount: 3, retryExhausted: true })
      expect(error.reason).toMatchObject({
        _tag: "Transport",
        kind: "connection",
        code: "ECONNRESET",
        message: "The provider connection closed before the response completed.",
      })
      expect(error.reason.message).not.toContain("secret-upstream-detail")
    }).pipe(
      Effect.provide(
        transportFailureLayer({
          message: "secret-upstream-detail",
          cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
        }),
      ),
    ),
  )

  it.effect("retries CONNECTIONREFUSED before an HTTP response and preserves the exact code", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust(10_000)
      const error = yield* Fiber.join(fiber)

      expectLLMError(error)
      expect(error).toMatchObject({ retryable: true, attemptCount: 3, retryExhausted: true })
      expect(error.reason).toMatchObject({
        _tag: "Transport",
        kind: "connection",
        code: "CONNECTIONREFUSED",
        message: "The provider refused the network connection.",
      })
    }).pipe(
      Effect.provide(
        transportFailureLayer(Object.assign(new Error("connection refused"), { code: "CONNECTIONREFUSED" })),
      ),
    ),
  )

  it.effect("does not retry non-transient TLS transport failures", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error).toMatchObject({ retryable: false, attemptCount: 1, retryExhausted: false })
      expect(error.reason).toMatchObject({
        _tag: "Transport",
        kind: "tls",
        code: "CERT_HAS_EXPIRED",
      })
    }).pipe(
      Effect.provide(
        transportFailureLayer(Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" })),
      ),
    ),
  )

  it.effect("classifies context overflow responses", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest", classification: "context-overflow" })
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"code":"context_length_exceeded","message":"prompt too long"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("does not classify generic HTTP 413 payload errors as context overflow", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect("classification" in error.reason ? error.reason.classification : undefined).toBeUndefined()
    }).pipe(Effect.provide(responsesLayer([new Response("request too large", { status: 413 })]))),
  )

  it.effect("does not classify ordinary invalid requests as context overflow", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect("classification" in error.reason ? error.reason.classification : undefined).toBeUndefined()
    }).pipe(Effect.provide(responsesLayer([new Response("invalid parameter", { status: 400 })]))),
  )

  it.effect("returns redacted diagnostics for retryable rate limits", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error).toMatchObject({
        retryable: true,
        retryAfterMs: 0,
        attemptCount: 3,
        retryExhausted: true,
        reason: {
          _tag: "RateLimit",
          rateLimit: { retryAfterMs: 0 },
          http: {
            requestId: "req_123",
            request: {
              method: "POST",
              url: "https://provider.test/v1/chat?api_key=%3Credacted%3E&key=%3Credacted%3E&debug=1",
              headers: { authorization: "<redacted>", "x-safe": "visible" },
            },
            response: {
              status: 429,
              headers: {
                "retry-after-ms": "0",
                "x-request-id": "req_123",
                "x-api-key": "<redacted>",
              },
            },
          },
        },
      })
      expect(errorHttp(error)?.body).toBe("rate limited")
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: { "retry-after-ms": "0", "x-request-id": "req_123", "x-api-key": "secret" },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("honors current redacted header names in diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.request.headers["x-safe"]).toBe("<redacted>")
      expect(errorHttp(error)?.response?.headers["x-safe"]).toBe("<redacted>")
    }).pipe(
      Effect.provide(responsesLayer([new Response("bad", { status: 400, headers: { "x-safe": "response-secret" } })])),
      Effect.provideService(Headers.CurrentRedactedNames, ["x-safe"]),
    ),
  )

  it.effect("extracts OpenAI-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
      expect(error.reason._tag === "RateLimit" ? error.reason.rateLimit : undefined).toEqual({
        retryAfterMs: 0,
        limit: { requests: "500", tokens: "30000" },
        remaining: { requests: "499", tokens: "29900" },
        reset: { requests: "1s", tokens: "10s" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: {
                  "retry-after-ms": "0",
                  "x-ratelimit-limit-requests": "500",
                  "x-ratelimit-limit-tokens": "30000",
                  "x-ratelimit-remaining-requests": "499",
                  "x-ratelimit-remaining-tokens": "29900",
                  "x-ratelimit-reset-requests": "1s",
                  "x-ratelimit-reset-tokens": "10s",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("extracts Anthropic-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
      expect(errorHttp(error)?.rateLimit).toEqual({
        retryAfterMs: 0,
        limit: { requests: "100", "input-tokens": "10000" },
        remaining: { requests: "12", "input-tokens": "9000" },
        reset: { requests: "2026-05-06T12:00:00Z", "input-tokens": "2026-05-06T12:00:10Z" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("overloaded", {
                status: 529,
                headers: {
                  "retry-after-ms": "0",
                  "anthropic-ratelimit-requests-limit": "100",
                  "anthropic-ratelimit-requests-remaining": "12",
                  "anthropic-ratelimit-requests-reset": "2026-05-06T12:00:00Z",
                  "anthropic-ratelimit-input-tokens-limit": "10000",
                  "anthropic-ratelimit-input-tokens-remaining": "9000",
                  "anthropic-ratelimit-input-tokens-reset": "2026-05-06T12:00:10Z",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("retries retryable status responses before returning the stream", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const response = yield* executor.execute(request)

      expect(response.status).toBe(200)
      expect(yield* response.text).toBe("ok")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
          new Response("ok", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("marks standard transient HTTP status responses retryable", () =>
    Effect.gen(function* () {
      const failWith = (status: number) =>
        Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const error = yield* executor.execute(request).pipe(Effect.flip)

          expectLLMError(error)
          expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status })
          expect(error.retryable).toBe(true)
        }).pipe(
          Effect.provide(
            responsesLayer(
              Array.from(
                { length: 3 },
                () =>
                  new Response("retry", {
                    status,
                    headers: { "retry-after-ms": "0" },
                  }),
              ),
            ),
          ),
        )

      for (const status of [408, 409, 500, 504, 529]) yield* failWith(status)
    }),
  )

  it.effect("does not retry exhausted subscription quota responses", () =>
    Effect.gen(function* () {
      const failWith = (status: number, body: string) =>
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          return yield* Effect.gen(function* () {
            const executor = yield* RequestExecutor.Service
            const error = yield* executor.execute(request).pipe(Effect.flip)

            expectLLMError(error)
            expect(error.reason).toMatchObject({ _tag: "QuotaExceeded" })
            expect(error.retryable).toBe(false)
            expect(error.attemptCount).toBe(1)
            expect(error.retryExhausted).toBe(false)
            expect(yield* Ref.get(attempts)).toBe(1)
          }).pipe(
            Effect.provide(
              countedResponsesLayer(attempts, [
                new Response(body, { status, headers: { "retry-after-ms": "0" } }),
                new Response("must not retry", { status: 200 }),
              ]),
            ),
          )
        })

      yield* failWith(402, "payment required")
      yield* failWith(400, '{"error":{"code":"insufficient_quota","message":"credit balance too low"}}')
      yield* failWith(
        429,
        '{"error":{"code":"token_quota_exceeded","message":"Token Plan Person monthly quota limit exceeded","type":"quota_exceeded"}}',
      )
      yield* failWith(
        429,
        '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}',
      )
    }),
  )

  it.effect("honors explicit provider retry directives", () =>
    Effect.gen(function* () {
      const noRetryAttempts = yield* Ref.make(0)
      const noRetry = yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        return yield* executor.execute(request).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(noRetryAttempts, [
            new Response("do not retry", { status: 503, headers: { "x-should-retry": "false" } }),
            new Response("must not retry", { status: 200 }),
          ]),
        ),
      )
      expectLLMError(noRetry)
      expect(noRetry).toMatchObject({
        reason: { _tag: "ProviderInternal", status: 503 },
        retryable: false,
        attemptCount: 1,
        retryExhausted: false,
      })
      expect(yield* Ref.get(noRetryAttempts)).toBe(1)

      const retryAttempts = yield* Ref.make(0)
      const response = yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        return yield* executor.execute(request)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(retryAttempts, [
            new Response("temporary bad request", {
              status: 400,
              headers: { "x-should-retry": "true", "retry-after-ms": "0" },
            }),
            new Response("ok", { status: 200 }),
          ]),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Ref.get(retryAttempts)).toBe(2)
    }),
  )

  it.effect("does not retry non-retryable status responses and truncates large bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Authentication" })
      expect(error.retryable).toBe(false)
      expect(error.attemptCount).toBe(1)
      expect(error.retryExhausted).toBe(false)
      expect(errorHttp(error)?.bodyTruncated).toBe(true)
      expect(errorHttp(error)?.body).toHaveLength(16_384)
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("x".repeat(20_000), { status: 401 }),
          new Response("should not retry", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("redacts common secret fields in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain('"key":"<redacted>"')
      expect(errorHttp(error)?.body).toContain("api_key=<redacted>")
      expect(errorHttp(error)?.body).not.toContain("body-secret")
      expect(errorHttp(error)?.body).not.toContain("query-secret")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"message":"bad","key":"body-secret","detail":"api_key=query-secret"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("redacts echoed request secret values in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(secretRequest).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain("provider echoed <redacted>")
      expect(errorHttp(error)?.body).toContain("authorization <redacted>")
      expect(errorHttp(error)?.body).not.toContain("query-secret-123")
      expect(errorHttp(error)?.body).not.toContain("header-secret-456")
      expect(errorHttp(error)?.body).not.toContain("account-secret-789")
      expect(errorHttp(error)?.request.headers["chatgpt-account-id"]).toBe("<redacted>")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response(
            "provider echoed query-secret-123, authorization header-secret-456, account account-secret-789",
            {
              status: 400,
            },
          ),
        ]),
      ),
    ),
  )

  it.effect("honors Retry-After delta seconds before retrying", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1_999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        const response = yield* Fiber.join(fiber)

        expect(response.status).toBe(200)
        expect(yield* Ref.get(attempts)).toBe(2)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503, headers: { "retry-after": "2" } }),
            new Response("ok", { status: 200 }),
          ]),
        ),
      )
    }),
  )

  it.effect("uses exponential jittered delay when retry-after is absent", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(499)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(1)
        const error = yield* Fiber.join(fiber)

        expectLLMError(error)
        expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
        expect(yield* Ref.get(attempts)).toBe(3)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503 }),
            new Response("still busy", { status: 503 }),
            new Response("done retrying", { status: 503 }),
          ]),
        ),
      )
    }).pipe(Effect.provideService(Random.Random, randomMidpoint)),
  )

  it.effect("does not retry after a successful response reaches stream parsing", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Ref.update(attempts, (value) => value + 1).pipe(
              Effect.as(
                input.respond(
                  sseRaw(
                    `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`,
                    "data: not-json",
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            ),
          ),
        ),
        Effect.flip,
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )
})
