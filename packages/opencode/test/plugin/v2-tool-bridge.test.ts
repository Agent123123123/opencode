import { describe, expect } from "bun:test"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import path from "path"
import { pathToFileURL } from "url"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Plugin } from "../../src/plugin"
import { V2PluginToolBridge } from "../../src/plugin/v2-tool-bridge"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DateTime } from "effect"

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)
const pluginLayer = Plugin.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(configLayer),
  Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
)
const it = testEffect(
  Layer.mergeAll(
    pluginLayer,
    V2PluginToolBridge.layer.pipe(
      Layer.provide(pluginLayer),
      Layer.provide(LocationServiceMap.layer),
    ),
    LocationServiceMap.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe("V2 plugin tool bridge", () => {
  it.instance("reuses an existing plugin tool and its rejectable hooks in the V2 registry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "plugin.ts")
      yield* Effect.all(
        [
          Effect.promise(() =>
            Bun.write(
              file,
              [
                "export default async () => ({",
                "  tool: {",
                "    bridge_echo: {",
                "      description: 'bridge echo',",
                "      args: {},",
                "      execute: async (args, ctx) => `${ctx.sessionID}:${ctx.messageID}:${args.text}` ,",
                "    },",
                "    bridge_ask: {",
                "      description: 'bridge permission',",
                "      args: {},",
                "      execute: async (_args, ctx) => {",
                "        await ctx.ask({ permission: 'bridge_permission', patterns: ['*'], always: [], metadata: {} })",
                "        return 'permission bypassed'",
                "      },",
                "    },",
                "  },",
                "  'tool.definition': async (input, output) => {",
                "    if (input.toolID === 'bridge_echo') output.jsonSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }",
                "  },",
                "  'tool.execute.before': async (input, output) => {",
                "    if (input.activityIdentity?.activityID !== 'msg_turn_bridge' || input.activityIdentity?.inputIDs?.join(',') !== 'msg_input') throw new Error('missing exact activity identity')",
                "    if (input.tool === 'read') throw new Error('blocked builtin read')",
                "    if (input.tool === 'bridge_echo') output.args.text += '-before'",
                "  },",
                "  'tool.execute.after': async (_input, output) => { output.output += '-after' },",
                "  'system.context': async (input, output) => { output.system.push(`context:${input.sessionID}:${input.agentID}:${input.model?.modelID}`) },",
                "})",
                "",
              ].join("\n"),
            ),
          ),
          Effect.promise(() =>
            Bun.write(
              path.join(test.directory, "opencode.json"),
              JSON.stringify({ plugin: [pathToFileURL(file).href] }),
            ),
          ),
        ],
        { concurrency: 2, discard: true },
      )

      yield* (yield* V2PluginToolBridge.Service).init()
      const materialized = yield* Effect.gen(function* () {
        return yield* (yield* ToolRegistry.Service).materialize()
      }).pipe(
        Effect.provide(
          (yield* LocationServiceMap).get(
            Location.Ref.make({ directory: AbsolutePath.make(test.directory) }),
          ),
        ),
      )
      expect(materialized.definitions.find((item) => item.name === "bridge_echo")?.inputSchema).toMatchObject({
        type: "object",
        required: ["text"],
      })
      const settled = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_bridge"),
        agent: AgentV2.ID.make("build"),
        turnID: SessionMessage.ID.make("msg_turn_bridge"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge"),
        activityInputIDs: [SessionMessage.ID.make("msg_input")],
        call: { type: "tool-call", id: "call_bridge", name: "bridge_echo", input: { text: "hello" } },
      })
      expect(settled.result).toEqual({
        type: "text",
        value: "ses_bridge:msg_bridge:hello-before-after",
      })
      const blockedBuiltin = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_bridge"),
        agent: AgentV2.ID.make("build"),
        turnID: SessionMessage.ID.make("msg_turn_bridge"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge"),
        activityInputIDs: [SessionMessage.ID.make("msg_input")],
        call: { type: "tool-call", id: "call_builtin_read", name: "read", input: { path: file } },
      })
      expect(blockedBuiltin.result).toEqual({ type: "error", value: "blocked builtin read" })
      const context = yield* Effect.gen(function* () {
        const registry = yield* SystemContextRegistry.Service
        return yield* registry.load({
          session: new SessionSchema.Info({
            id: SessionSchema.ID.make("ses_bridge"),
            projectID: ProjectV2.ID.make("project-bridge"),
            agent: AgentV2.ID.make("analyst"),
            model: {
              providerID: ProviderV2.ID.make("test"),
              id: ModelV2.ID.make("test-model"),
            },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            title: "Bridge",
            location: { directory: AbsolutePath.make(test.directory) },
          }),
          agent: { id: AgentV2.ID.make("analyst"), info: undefined },
          effectiveModel: {
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("test-model"),
          },
          activityInputIDs: [SessionMessage.ID.make("msg_input")],
        })
      }).pipe(
        Effect.provide(
          (yield* LocationServiceMap).get(
            Location.Ref.make({ directory: AbsolutePath.make(test.directory) }),
          ),
        ),
      )
      expect((yield* SystemContext.initialize(context)).baseline).toContain("context:ses_bridge:analyst:test-model")
      const rejected = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_missing_for_permission"),
        agent: AgentV2.ID.make("build"),
        turnID: SessionMessage.ID.make("msg_turn_bridge_permission"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge_permission"),
        activityInputIDs: [],
        call: { type: "tool-call", id: "call_bridge_permission", name: "bridge_ask", input: {} },
      })
      expect(rejected.result).toMatchObject({ type: "error" })
    }),
  )
})
