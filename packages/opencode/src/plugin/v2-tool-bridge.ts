import type { Hooks, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { z } from "zod"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { Plugin } from "."

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/V2PluginToolBridge") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap
    const plugin = yield* Plugin.Service
    const state = yield* InstanceState.make(
      Effect.fn("V2PluginToolBridge.state")(function* (instance) {
        const hooks = yield* plugin.list()
        const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))
        const [tools, permission] = yield* Effect.all(
          [Tools.Service, PermissionV2.Service],
          { concurrency: 2 },
        ).pipe(
          Effect.provide(services),
        )
        const registered = yield* compatibleTools(
          hooks,
          { directory: instance.directory, worktree: instance.worktree },
          permission,
        )
        if (Object.keys(registered).length === 0) return
        yield* tools.register(registered).pipe(Effect.orDie)
      }),
    )
    return Service.of({ init: () => InstanceState.get(state) })
  }),
)

const compatibleTools = Effect.fn("V2PluginToolBridge.compatibleTools")(function* (
  hooks: Hooks[],
  location: { directory: string; worktree: string },
  permission: PermissionV2.Interface,
) {
  const definitions = new Map<string, ToolDefinition>()
  for (const hook of hooks) {
    for (const [name, definition] of Object.entries(hook.tool ?? {})) definitions.set(name, definition)
  }

  return Object.fromEntries(
    yield* Effect.forEach(
      definitions,
      Effect.fnUntraced(function* ([name, definition]) {
        const output = {
          description: definition.description,
          parameters: definition.args,
          jsonSchema: z.toJSONSchema(z.object(definition.args ?? {}), { io: "input" }),
        }
        for (const hook of hooks) {
          if (!hook["tool.definition"]) continue
          yield* Effect.tryPromise({
            try: () => hook["tool.definition"]!({ toolID: name }, output),
            catch: errorMessage,
          }).pipe(Effect.orDie)
        }
        return [
          name,
          Tool.make({
            description: output.description,
            input: Schema.Unknown,
            inputJsonSchema: output.jsonSchema,
            output: Schema.String,
            execute: (args, context) =>
              execute(hooks, definition, name, args, context, location, permission).pipe(
                Effect.mapError((error) => new Tool.Failure({ message: error })),
              ),
          }),
        ] as const
      }),
      { concurrency: 1 },
    ),
  )
})

const execute = Effect.fn("V2PluginToolBridge.execute")(function* (
  hooks: Hooks[],
  definition: ToolDefinition,
  name: string,
  args: unknown,
  context: Tool.Context,
  location: { directory: string; worktree: string },
  permission: PermissionV2.Interface,
) {
  const input = {
    tool: name,
    sessionID: context.sessionID,
    callID: context.toolCallID,
    activityIdentity: {
      activityID: context.assistantMessageID,
      inputIDs: context.activityInputIDs ?? [],
      assistantMessageID: context.assistantMessageID,
    },
  }
  const mutable = { args }
  for (const hook of hooks) {
    if (!hook["tool.execute.before"]) continue
    yield* Effect.tryPromise({
      try: () => hook["tool.execute.before"]!(input, mutable),
      catch: errorMessage,
    })
  }

  const controller = new AbortController()
  const result = yield* Effect.tryPromise({
    try: () => definition.execute(mutable.args as never, toolContext(context, location, controller.signal, permission)),
    catch: errorMessage,
  }).pipe(Effect.ensuring(Effect.sync(() => controller.abort())))
  const output = normalizeResult(name, result)
  for (const hook of hooks) {
    if (!hook["tool.execute.after"]) continue
    yield* Effect.tryPromise({
      try: () => hook["tool.execute.after"]!({ ...input, args: mutable.args }, output),
      catch: errorMessage,
    })
  }
  return output.output
})

function toolContext(
  context: Tool.Context,
  location: { directory: string; worktree: string },
  abort: AbortSignal,
  permission: PermissionV2.Interface,
): ToolContext {
  return {
    sessionID: context.sessionID,
    messageID: context.assistantMessageID,
    agent: context.agent,
    directory: location.directory,
    worktree: location.worktree,
    abort,
    metadata() {},
    ask(input) {
      return Effect.runPromise(permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        action: input.permission,
        resources: input.patterns,
        save: input.always,
        metadata: input.metadata,
        source: {
          type: "tool",
          messageID: context.assistantMessageID,
          callID: context.toolCallID,
        },
      }))
    },
  }
}

function normalizeResult(name: string, result: ToolResult) {
  if (typeof result === "string") return { title: name, output: result, metadata: {} }
  return {
    title: result.title ?? name,
    output: result.output,
    metadata: result.metadata ?? {},
  }
}

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])
export const node = LayerNode.make(layer, [Plugin.node, locationServiceMapNode])

export * as V2PluginToolBridge from "./v2-tool-bridge"
