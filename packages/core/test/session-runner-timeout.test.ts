import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMError } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { ConfigMigrateV1 } from "../src/v1/config/migrate"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionV2 } from "../src/session"

const scenarios = [
  { name: "chunk deadline after a retried HTTP request retains the logical attempt count", mode: "retry-stall", options: { timeout: false, headerTimeout: 100, chunkTimeout: 100 }, code: "HTTP_CHUNK_TIMEOUT", attempts: 2 },
  { name: "header deadline", mode: "headers", options: { timeout: false, headerTimeout: 100 }, code: "HTTP_HEADER_TIMEOUT", attempts: 3 },
  { name: "total deadline before headers", mode: "headers", options: { timeout: 100, headerTimeout: false }, code: "HTTP_REQUEST_TIMEOUT", attempts: 3 },
  { name: "total deadline across a stalled stream", mode: "stall", options: { timeout: 100, headerTimeout: 100 }, code: "HTTP_REQUEST_TIMEOUT", attempts: 1 },
  { name: "raw SSE chunk deadline", mode: "stall", options: { timeout: false, headerTimeout: 100, chunkTimeout: 100 }, code: "HTTP_CHUNK_TIMEOUT", attempts: 1 },
  { name: "total deadline across an error body", mode: "error", options: { timeout: 100, headerTimeout: 100 }, code: "HTTP_REQUEST_TIMEOUT", attempts: 3 },
  { name: "disabled total preserves complete provider error classification", mode: "error", options: { timeout: false, headerTimeout: 100, chunkTimeout: 50 }, code: undefined, attempts: 1 },
  { name: "SSE comments keep the chunk deadline alive", mode: "heartbeat", options: { timeout: false, headerTimeout: 100, chunkTimeout: 100 }, code: undefined, attempts: 1 },
  { name: "total deadline still bounds an active byte stream", mode: "heartbeat", options: { timeout: 100, headerTimeout: 100, chunkTimeout: 100 }, code: "HTTP_REQUEST_TIMEOUT", attempts: 1 },
  { name: "explicitly disabled header and total deadlines", mode: "headers", options: { timeout: false, headerTimeout: false }, code: undefined, attempts: 1 },
] as const

test.each([...scenarios])("model configuration enforces $name through real fetch", async (scenario) => {
  const attempts: Array<{ started: number; aborted?: number }> = []
  const bodies: Record<string, unknown>[] = []
  const encoder = new TextEncoder()
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "timeout-fixture", object: "chat.completion.chunk", created: 1, model: "probe",
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.json() as Record<string, unknown>)
    if (scenario.mode === "retry-stall" && bodies.length === 1) return Response.json({ error: { message: "busy" } }, { status: 503, headers: { "retry-after-ms": "0" } })
    if (scenario.mode === "headers") {
      await Bun.sleep(350)
      return Response.json({ error: { message: "Invalid fixture credentials" } }, { status: 401 })
    }
    let close: ReturnType<typeof setTimeout>
    let heartbeat: ReturnType<typeof setInterval> | undefined
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(scenario.mode === "error" ? '{"error":{"message":"' : frame({ content: "hello" })))
        if (scenario.mode === "heartbeat") heartbeat = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 25)
        close = setTimeout(() => {
          clearInterval(heartbeat)
          controller.enqueue(encoder.encode(scenario.mode === "error" ? 'Invalid fixture credentials"}}' : frame({}, "stop") + "data: [DONE]\n\n"))
          controller.close()
        }, 350)
      },
      cancel() { clearTimeout(close); clearInterval(heartbeat) },
    }), { status: scenario.mode === "error" ? 401 : 200,
      headers: { "content-type": scenario.mode === "error" ? "application/json" : "text/event-stream" } })
  } })
  try {
    const migrated = ConfigMigrateV1.migrate({ provider: { probe: { npm: "@ai-sdk/openai-compatible",
      options: { ...scenario.options, baseURL: server.url.href } } } })
    const model = await Effect.runPromise(SessionRunnerModel.fromCatalogModel(ModelV2.Info.make({
      id: ModelV2.ID.make("probe"), providerID: ProviderV2.ID.make("probe"), name: "Probe",
      api: { id: ModelV2.ID.make("probe"), ...migrated.providers!.probe.api! },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      request: { headers: {}, body: {} }, variants: [], time: { released: 0 }, cost: [], status: "active", enabled: true,
      limit: { context: 1000, output: 20 },
    }), { sessionID: SessionV2.ID.make("ses_timeout_fixture") }))
    expect(model.route.defaults?.http).toMatchObject(scenario.options)
    const result = await Effect.runPromise(LLMClient.stream(LLM.request({ model, prompt: "hi" })).pipe(
      Stream.runCollect,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(FetchHttpClient.Fetch, Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const attempt: { started: number; aborted?: number } = { started: performance.now() }
        attempts.push(attempt)
        init?.signal?.addEventListener("abort", () => { attempt.aborted = performance.now() }, { once: true })
        return fetch(input, init)
      }, { preconnect: fetch.preconnect })),
      Effect.result,
    ))
    expect(attempts).toHaveLength(scenario.attempts)
    expect(bodies.every((body) => !["timeout", "headerTimeout", "chunkTimeout"].some((key) => key in body))).toBe(true)
    if (scenario.code) {
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("expected timeout failure")
      expect(result.failure).toBeInstanceOf(LLMError)
      expect(result.failure).toMatchObject({ reason: { _tag: "Transport", kind: "timeout", code: scenario.code }, attemptCount: scenario.attempts })
      for (const attempt of scenario.mode === "retry-stall" ? attempts.slice(1) : attempts) {
        expect(attempt.aborted).toBeDefined()
        expect(attempt.aborted! - attempt.started).toBeLessThan(325)
      }
    } else if (scenario.mode === "heartbeat") {
      expect(result._tag).toBe("Success")
    } else {
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("expected complete authentication failure")
      expect(result.failure).toMatchObject({ reason: { _tag: "Authentication" }, retryable: false, attemptCount: 1 })
    }
  } finally { await server.stop(true) }
}, 10_000)
