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
                "    if (input.activityIdentity?.activityID !== 'msg_bridge' || input.activityIdentity?.inputIDs?.join(',') !== 'msg_input') throw new Error('missing exact activity identity')",
                "    output.args.text += '-before'",
                "  },",
                "  'tool.execute.after': async (_input, output) => { output.output += '-after' },",
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
        assistantMessageID: SessionMessage.ID.make("msg_bridge"),
        activityInputIDs: [SessionMessage.ID.make("msg_input")],
        call: { type: "tool-call", id: "call_bridge", name: "bridge_echo", input: { text: "hello" } },
      })
      expect(settled.result).toEqual({
        type: "text",
        value: "ses_bridge:msg_bridge:hello-before-after",
      })
      const rejected = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_missing_for_permission"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge_permission"),
        call: { type: "tool-call", id: "call_bridge_permission", name: "bridge_ask", input: {} },
      })
      expect(rejected.result).toMatchObject({ type: "error" })
    }),
  )
})
