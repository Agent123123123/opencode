import { expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Schedule } from "effect"

const marker = "FAILED_REASONING_E2E_MARKER"
const lengthMarker = "LENGTH_REASONING_E2E_MARKER"

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: object) => ({
  id: "chatcmpl_e2e",
  choices: [{ delta, finish_reason: finishReason }],
  ...(usage === undefined ? {} : { usage }),
})

const events = (...items: readonly unknown[]) =>
  `${items.map((item) => `data: ${item === "[DONE]" ? item : JSON.stringify(item)}\n\n`).join("")}`

test("same Sessions continue after failed and length-exhausted reasoning-only turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-session-projection-e2e-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const bodies: Record<string, unknown>[] = []
  const provider = createServer(async (request, response) => {
    const body = await Array.fromAsync(request)
    bodies.push(JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, unknown>)
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    if (bodies.length === 1) {
      response.write(events(chunk({ role: "assistant" }), chunk({ reasoning_content: marker })), () => {
        setTimeout(() => {
          response.socket?.on("error", () => undefined)
          response.socket?.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
        }, 100)
      })
      return
    }
    if (bodies.length === 2) {
      response.end(
        events(
          chunk({ role: "assistant" }),
          chunk({ content: "Recovered after reset" }),
          chunk({}, "stop", { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }),
          "[DONE]",
        ),
      )
      return
    }
    if (bodies.length === 3) {
      response.end(
        events(
          chunk({ role: "assistant" }),
          chunk({ reasoning_content: lengthMarker }),
          chunk({}, "length", {
            prompt_tokens: 11,
            completion_tokens: 8,
            total_tokens: 19,
            completion_tokens_details: { reasoning_tokens: 8 },
          }),
          "[DONE]",
        ),
      )
      return
    }
    response.end(
      events(
        chunk({ role: "assistant" }),
        chunk({ content: "Recovered after length exhaustion" }),
        chunk({}, "stop", { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 }),
        "[DONE]",
      ),
    )
  })
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject)
    provider.listen(0, "127.0.0.1", resolve)
  })
  const address = provider.address() as AddressInfo

  try {
    await Bun.write(
      join(directory, "opencode.jsonc"),
      JSON.stringify({
        model: "projection-e2e/recovery",
        providers: {
          "projection-e2e": {
            api: {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `http://127.0.0.1:${address.port}/v1`,
            },
            request: { headers: { Authorization: "Bearer test" } },
            models: {
              recovery: {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 32_000, output: 1_000 },
              },
            },
          },
        },
      }),
    )
    const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session } = await import("../src")
    const sessionID = Session.ID.make(`ses_projection_e2e_${crypto.randomUUID()}`)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opencode = yield* OpenCode.create()
          yield* opencode.sessions.create({
            id: sessionID,
            agent: Agent.ID.make("build"),
            model: Model.Ref.make({
              id: Model.ID.make("recovery"),
              providerID: Provider.ID.make("projection-e2e"),
            }),
            location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
          })
          yield* opencode.sessions.switchModel({
            sessionID,
            model: Model.Ref.make({
              id: Model.ID.make("recovery"),
              providerID: Provider.ID.make("projection-e2e"),
            }),
          })
          yield* opencode.sessions.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Start the interrupted turn" }),
          })
          const failed = yield* opencode.sessions.context({ sessionID }).pipe(
            Effect.filterOrFail(
              (context) => JSON.stringify(context).includes(marker) && JSON.stringify(context).includes('"error"'),
              () => "failed assistant is not durable yet",
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                opencode.sessions
                  .context({ sessionID })
                  .pipe(
                    Effect.flatMap((context) =>
                      Effect.die(`failed turn did not settle: ${JSON.stringify({ bodies: bodies.length, context })}`),
                    ),
                  ),
            }),
          )

          expect(failed).toMatchObject([
            { type: "user", text: "Start the interrupted turn" },
            {
              type: "assistant",
              finish: "error",
              content: [{ type: "reasoning", text: marker }],
            },
          ])
          const failedHistory = yield* opencode.sessions.history({ sessionID, after: 0, limit: 100 })
          expect(JSON.stringify(failedHistory.data)).toContain(marker)
          expect(JSON.stringify(failedHistory.data)).toContain("session.next.step.failed")

          yield* opencode.sessions.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Continue in the same Session" }),
          })
          const recovered = yield* opencode.sessions.context({ sessionID }).pipe(
            Effect.filterOrFail(
              (context) => JSON.stringify(context).includes("Recovered after reset"),
              () => "successor assistant is not durable yet",
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeout("5 seconds"),
          )

          expect(recovered).toMatchObject([
            { type: "user", text: "Start the interrupted turn" },
            { type: "assistant", finish: "error", content: [{ type: "reasoning", text: marker }] },
            { type: "user", text: "Continue in the same Session" },
            { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered after reset" }] },
          ])
          expect(bodies).toHaveLength(2)
          expect(JSON.stringify(bodies[1])).not.toContain(marker)
          const secondMessages = bodies[1]?.messages as Record<string, unknown>[]
          expect(secondMessages.filter((message) => message.role === "user")).toEqual([
            { role: "user", content: "Start the interrupted turn" },
            { role: "user", content: "Continue in the same Session" },
          ])
          expect(secondMessages.some((message) => message.role === "assistant")).toBe(false)
          expect((yield* opencode.sessions.get({ sessionID })).id).toBe(sessionID)

          const lengthSessionID = Session.ID.make(`ses_length_projection_e2e_${crypto.randomUUID()}`)
          yield* opencode.sessions.create({
            id: lengthSessionID,
            agent: Agent.ID.make("build"),
            model: Model.Ref.make({
              id: Model.ID.make("recovery"),
              providerID: Provider.ID.make("projection-e2e"),
            }),
            location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
          })
          yield* opencode.sessions.switchModel({
            sessionID: lengthSessionID,
            model: Model.Ref.make({
              id: Model.ID.make("recovery"),
              providerID: Provider.ID.make("projection-e2e"),
            }),
          })
          yield* opencode.sessions.prompt({
            sessionID: lengthSessionID,
            prompt: Prompt.make({ text: "Start the length-exhausted turn" }),
          })
          const exhausted = yield* opencode.sessions.context({ sessionID: lengthSessionID }).pipe(
            Effect.filterOrFail(
              (context) => JSON.stringify(context).includes(lengthMarker),
              () => "length-exhausted assistant is not durable yet",
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeout("5 seconds"),
          )

          expect(exhausted).toMatchObject([
            { type: "user", text: "Start the length-exhausted turn" },
            {
              type: "assistant",
              finish: "length",
              tokens: { output: 0, reasoning: 8 },
              content: [{ type: "reasoning", text: lengthMarker }],
            },
          ])
          const exhaustedHistory = yield* opencode.sessions.history({
            sessionID: lengthSessionID,
            after: 0,
            limit: 100,
          })
          expect(JSON.stringify(exhaustedHistory.data)).toContain(lengthMarker)
          expect(JSON.stringify(exhaustedHistory.data)).toContain("session.next.step.ended")

          yield* opencode.sessions.prompt({
            sessionID: lengthSessionID,
            prompt: Prompt.make({ text: "Continue after the exhausted internal reasoning" }),
          })
          const lengthRecovered = yield* opencode.sessions.context({ sessionID: lengthSessionID }).pipe(
            Effect.filterOrFail(
              (context) => JSON.stringify(context).includes("Recovered after length exhaustion"),
              () => "successor assistant is not durable yet",
            ),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeout("5 seconds"),
          )

          expect(lengthRecovered).toMatchObject([
            { type: "user", text: "Start the length-exhausted turn" },
            { type: "assistant", finish: "length", content: [{ type: "reasoning", text: lengthMarker }] },
            { type: "user", text: "Continue after the exhausted internal reasoning" },
            {
              type: "assistant",
              finish: "stop",
              content: [{ type: "text", text: "Recovered after length exhaustion" }],
            },
          ])
          expect(bodies).toHaveLength(4)
          expect(JSON.stringify(bodies[3])).not.toContain(lengthMarker)
          const fourthMessages = bodies[3]?.messages as Record<string, unknown>[]
          expect(fourthMessages.filter((message) => message.role === "user")).toEqual([
            { role: "user", content: "Start the length-exhausted turn" },
            { role: "user", content: "Continue after the exhausted internal reasoning" },
          ])
          expect(fourthMessages.some((message) => message.role === "assistant")).toBe(false)
          expect((yield* opencode.sessions.get({ sessionID: lengthSessionID })).id).toBe(lengthSessionID)
        }),
      ),
    )
  } finally {
    Flag.OPENCODE_DB = database
    provider.closeAllConnections()
    if (provider.listening)
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
