import { expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Schedule } from "effect"

const marker = "FAILED_REASONING_E2E_MARKER"

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: object) => ({
  id: "chatcmpl_e2e",
  choices: [{ delta, finish_reason: finishReason }],
  ...(usage === undefined ? {} : { usage }),
})

const events = (...items: readonly unknown[]) =>
  `${items.map((item) => `data: ${item === "[DONE]" ? item : JSON.stringify(item)}\n\n`).join("")}`

test("same Session continues after a reasoning stream is reset", async () => {
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
    response.end(
      events(
        chunk({ role: "assistant" }),
        chunk({ content: "Recovered after reset" }),
        chunk({}, "stop", { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }),
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
}, 15_000)
