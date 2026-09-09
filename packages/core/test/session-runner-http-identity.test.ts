import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Location } from "@opencode-ai/core/location"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { afterAll, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

import { FetchHttpClient } from "effect/unstable/http"
import { node } from "@opencode-ai/core/session/runner/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Tool } from "@opencode-ai/core/tool/tool"
import { InstallationUserAgent } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"

const RequestBody = Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String })) })
const requests: { headers: Headers; body: typeof RequestBody.Type }[] = []
let callTool = false
let retry = false
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = Schema.decodeUnknownSync(RequestBody)(await request.json())
    requests.push({ headers: request.headers, body })
    if (retry) {
      retry = false
      return Response.json(
        { error: { message: "retry fixture", type: "rate_limit_error" } },
        { status: 429, headers: { "retry-after": "0" } },
      )
    }
    const tool = callTool && !body.messages.some((message: { role: string }) => message.role === "tool")
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_echo",
                      type: "function",
                      function: { name: "echo", arguments: '{"text":"hello"}' },
                    },
                  ],
                }
              : { role: "assistant", content: "Hello!" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]
    return new Response(
      chunks
        .map(
          (chunk) =>
            `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => server.stop(true))
const executor = RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const models = SessionRunnerModel.layerWith((session) =>
  SessionRunnerModel.resolve(
    session,
    ModelV2.Info.make({
      id: ModelV2.ID.make("test-model"),
      providerID: session.model!.providerID,
      name: "HTTP fixture",
      api: {
        id: ModelV2.ID.make("test-model"),
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: server.url.href,
        settings: { apiKey: "fixture-secret", timeout: 200, headerTimeout: 200 },
      },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      request: {
        headers: {
          "X-Opencode-Session": "stale-session",
          "X-Opencode-Request": "stale-request",
          "X-Opencode-Project": "stale-project",
          "X-Opencode-Client": "stale-client",
          "User-Agent": "configured-agent",
          "x-configured": "preserved",
        },
        body: {},
      },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 100000, output: 200 },
    }),
  ),
)
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const runnerLayer = AppNodeBuilder.build(node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Config.node, config],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
    ],
  ),
)

describe("SessionRunner provider HTTP identity", () => {
  for (const provider of ["opencode", "opencode-go", "third-party"]) {
    it.live(`preserves auth and catalog headers through actual ${provider} HTTP requests`, () =>
      Effect.gen(function* () {
        requests.length = 0
        callTool = false
        retry = false
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const sessions = yield* SessionV2.Service
        for (const suffix of ["a", "b"]) {
          const sessionID = SessionV2.ID.make(`ses_http_${provider}_${suffix}`)
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Project.ID.global,
              slug: "test",
              directory: "/project",
              title: "test",
              version: "test",
              model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make(provider) },
            })
            .run()
            .pipe(Effect.orDie)
          yield* sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Say hello." }), resume: false })
          yield* sessions.resume(sessionID)
          const messages = yield* sessions.context(sessionID)
          expect(messages.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
          const headers = requests.at(-1)!.headers
          expect(headers.get("authorization")).toBe("Bearer fixture-secret")
          expect(headers.get("x-configured")).toBe("preserved")
          if (provider.startsWith("opencode")) {
            expect(headers.get("x-opencode-session")).toBe(sessionID)
            expect(headers.get("x-opencode-project")).toBe(Project.ID.global)
            const history = yield* sessions.history({ sessionID, limit: 100 })
            const started = history.events.find((event) => event.type === "session.turn.started")
            if (started?.type !== "session.turn.started") return yield* Effect.die("Missing durable Turn")
            expect(headers.get("x-opencode-request")).toBe(started.data.turnID)
            expect(headers.get("x-opencode-client")).toBe(Flag.OPENCODE_CLIENT)
            expect(headers.get("user-agent")).toBe(InstallationUserAgent)
          } else {
            expect(headers.get("x-opencode-session")).toBe("stale-session")
            expect(headers.get("x-opencode-request")).toBe("stale-request")
            expect(headers.get("x-opencode-project")).toBe("stale-project")
            expect(headers.get("x-opencode-client")).toBe("stale-client")
            expect(headers.get("user-agent")).toBe("configured-agent")
          }
        }
        expect(requests).toHaveLength(2)
        if (provider.startsWith("opencode")) {
          expect(requests[0]!.headers.get("x-opencode-request")).not.toBe(
            requests[1]!.headers.get("x-opencode-request"),
          )
        }
      }),
    )
  }

  for (const continuationRetry of [false, true]) it.live(
    `keeps Turn identity and independent retry counts across a slow tool continuation (retry=${continuationRetry})`,
    () =>
      Effect.gen(function* () {
        requests.length = 0
        callTool = true
        retry = true
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const sessionID = SessionV2.ID.make("ses_http_tool_retry")
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "test",
            directory: "/project",
            title: "test",
            version: "test",
            model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("opencode") },
          })
          .run()
          .pipe(Effect.orDie)
        const registry = yield* ToolRegistry.Service
        const executed: string[] = []
        yield* registry.register({
          echo: Tool.make({
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
            execute: (input) =>
              Effect.sync(() => {
                executed.push(input.text)
                retry = continuationRetry
                return input
              }).pipe(Effect.delay(350)),
          }),
        })
        const sessions = yield* SessionV2.Service
        yield* sessions.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Echo hello using the tool." }),
          resume: false,
        })
        yield* sessions.resume(sessionID)
        expect(executed).toEqual(["hello"])
        expect(requests).toHaveLength(continuationRetry ? 4 : 3)
        const history = yield* sessions.history({ sessionID, limit: 200 })
        const retries = history.events.filter((event) => event.type === "session.next.retried")
        expect(retries).toHaveLength(continuationRetry ? 4 : 2)
        expect(retries.every((event) => event.durable?.version === 2)).toBe(true)
        expect(retries.map((event) => event.data.phase)).toEqual(continuationRetry ? ["waiting", "requesting", "waiting", "requesting"] : ["waiting", "requesting"])
        expect(new Set(retries.map((event) => event.data.requestID)).size).toBe(continuationRetry ? 2 : 1)
        for (const event of retries) expect(event.data).toMatchObject({ sessionID,
          retryAttempt: 1, retryLimit: 2, failure: { kind: "rate_limit", httpStatus: 429,
            retryable: true, retryExhausted: false, providerID: "opencode", modelID: "test-model" } })
        const started = history.events.find((event) => event.type === "session.turn.started")!
        for (const event of retries) {
          expect(event.data.turnID).toBe(started.data.turnID)
          expect(event.data.activityInputIDs).toEqual(started.data.activityInputIDs)
        }
        expect(new Set(requests.map((request) => request.headers.get("x-opencode-request"))).size).toBe(1)
        for (const request of requests) expect(request.headers.get("x-opencode-session")).toBe(sessionID)
        expect(requests[2]!.body.messages.some((message) => message.role === "tool")).toBe(true)
        expect((yield* sessions.context(sessionID)).at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
      }),
    15000,
  )
})
