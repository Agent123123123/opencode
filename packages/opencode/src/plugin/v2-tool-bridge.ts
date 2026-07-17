import type { Hooks, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, LocationServiceMapLive } from "@opencode-ai/core/location-layer"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ToolExecutionPolicy } from "@opencode-ai/core/tool/execution-policy"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
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
        const [tools, permission, executionPolicies, systemContexts] = yield* Effect.all(
          [Tools.Service, PermissionV2.Service, ToolExecutionPolicy.Service, SystemContextRegistry.Service],
          { concurrency: 2 },
        ).pipe(
          Effect.provide(services),
        )
        yield* registerLegacyExecutionPolicy(executionPolicies, hooks)
        yield* registerSystemContextContributors(systemContexts, hooks)
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
              execute(definition, name, args, context, location, permission).pipe(
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
  definition: ToolDefinition,
  name: string,
  args: unknown,
  context: Tool.Context,
  location: { directory: string; worktree: string },
  permission: PermissionV2.Interface,
) {
  const controller = new AbortController()
  const result = yield* Effect.tryPromise({
    try: () => definition.execute(args as never, toolContext(context, location, controller.signal, permission)),
    catch: errorMessage,
  }).pipe(Effect.ensuring(Effect.sync(() => controller.abort())))
  const output = normalizeResult(name, result)
  return output.output
})

const registerLegacyExecutionPolicy = Effect.fn("V2PluginToolBridge.registerLegacyExecutionPolicy")(function* (
  service: ToolExecutionPolicy.Interface,
  hooks: Hooks[],
) {
  if (!hooks.some((hook) => hook["tool.execute.before"] || hook["tool.execute.after"])) return
  yield* service.register({
    before: (invocation) =>
      Effect.gen(function* () {
        const input = legacyInvocation(invocation)
        const mutable = { args: invocation.validatedInput }
        for (const hook of hooks) {
          if (!hook["tool.execute.before"]) continue
          yield* Effect.tryPromise({
            try: () => hook["tool.execute.before"]!(input, mutable),
            catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
          })
        }
        return mutable.args
      }),
    after: (invocation, result) =>
      Effect.gen(function* () {
        const output = {
          title: invocation.toolName,
          output: typeof result === "string" ? result : JSON.stringify(result),
          metadata: {},
        }
        for (const hook of hooks) {
          if (!hook["tool.execute.after"]) continue
          yield* Effect.tryPromise({
            try: () => hook["tool.execute.after"]!({ ...legacyInvocation(invocation), args: invocation.validatedInput }, output),
            catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
          })
        }
        if (typeof result === "string" && output.output !== result) return output.output
      }),
  })
})

const pluginSystemContextKey = SystemContext.Key.make("plugin/system-context")

const registerSystemContextContributors = Effect.fn("V2PluginToolBridge.registerSystemContextContributors")(function* (
  service: SystemContextRegistry.Interface,
  hooks: Hooks[],
) {
  if (!hooks.some((hook) => hook["system.context"])) return
  yield* service.register({
    key: pluginSystemContextKey,
    load: (request) =>
      Effect.gen(function* () {
        const output = { system: [] as string[] }
        for (const hook of hooks) {
          if (!hook["system.context"]) continue
          yield* Effect.tryPromise({
            try: () =>
              hook["system.context"]!(
                {
                  sessionID: request.session.id,
                  agentID: request.agent.id,
                  activityInputIDs: request.activityInputIDs,
                  model: request.effectiveModel
                    ? {
                        providerID: request.effectiveModel.providerID,
                        modelID: request.effectiveModel.id,
                        variant: request.effectiveModel.variant,
                      }
                    : undefined,
                },
                output,
              ),
            catch: errorMessage,
          }).pipe(Effect.orDie)
        }
        if (output.system.length === 0) return SystemContext.empty
        return SystemContext.make({
          key: pluginSystemContextKey,
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.succeed(output.system.join("\n")),
          baseline: String,
          update: (_previous, current) => current,
          removed: () => "Plugin-contributed system context no longer applies.",
        })
      }),
  })
})

function legacyInvocation(invocation: ToolExecutionPolicy.Invocation) {
  return {
    tool: invocation.toolName,
    sessionID: invocation.sessionID,
    callID: invocation.toolCallID,
    activityIdentity: {
      activityID: invocation.turnID,
      inputIDs: [...invocation.activityInputIDs],
      assistantMessageID: invocation.assistantMessageID,
    },
  }
}

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
      return Effect.runPromise(permission.assert(Tool.permissionRequest(context, {
        action: input.permission,
        resources: input.patterns,
        save: input.always,
        metadata: input.metadata,
      })))
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

export const sharedDefaultLayer = layer.pipe(Layer.provide(Plugin.defaultLayer))

export const defaultLayer = sharedDefaultLayer.pipe(Layer.provide(LocationServiceMapLive))

const locationServiceMapNode = LayerNode.make(LocationServiceMapLive, [])
export const node = LayerNode.make(layer, [Plugin.node, locationServiceMapNode])

export * as V2PluginToolBridge from "./v2-tool-bridge"
