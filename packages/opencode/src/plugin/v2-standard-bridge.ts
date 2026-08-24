import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SystemContext } from "@opencode-ai/core/system-context/index"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolExecution } from "@opencode-ai/core/tool/execution"
import { Tools } from "@opencode-ai/core/tool/tools"
import { SkillV2 } from "@opencode-ai/core/skill"
import type { ToolOutput } from "@opencode-ai/llm"
import type { Hooks, ToolContext, ToolDefinition, ToolResult } from "@opencode-ai/plugin"
import { Context, Effect, Layer, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { pluginToolSchema } from "@/tool/registry"
import { Plugin } from "."

export interface Interface {
  readonly init: (services: RegistrationServices) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/V2StandardPluginBridge") {}

export interface RegistrationServices {
  readonly tools: Tools.Interface
  readonly execution: ToolExecution.Interface
  readonly contexts: SystemContextRegistry.Interface
  readonly skills: SkillV2.Interface
}

const systemContextKey = SystemContext.Key.make("plugin/v1-system-context")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const registrations = new Map<string, RegistrationServices>()
    const state = yield* InstanceState.make(
      Effect.fn("V2StandardPluginBridge.state")(function* (instance) {
        const services = registrations.get(instance.directory)
        if (!services) return yield* Effect.die(`Missing location services for ${instance.directory}`)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (registrations.get(instance.directory) === services) registrations.delete(instance.directory)
          }),
        )
        const hooks = yield* plugin.list()
        yield* Effect.gen(function* () {
          const tools = yield* Tools.Service
          const execution = yield* ToolExecution.Service
          const contexts = yield* SystemContextRegistry.Service
          const skills = yield* SkillV2.Service
          const definitions = yield* compatibleTools(hooks, instance).pipe(Effect.orDie)
          yield* registerExecutionHooks(execution, hooks, new Set(Object.keys(definitions)))
          yield* registerSystemContext(contexts, hooks)
          yield* registerSkills(skills, hooks)
          if (Object.keys(definitions).length > 0) yield* tools.register(definitions).pipe(Effect.orDie)
        }).pipe(
          Effect.provideService(Tools.Service, services.tools),
          Effect.provideService(ToolExecution.Service, services.execution),
          Effect.provideService(SystemContextRegistry.Service, services.contexts),
          Effect.provideService(SkillV2.Service, services.skills),
        )
      }),
    )
    return Service.of({
      init: (services) =>
        Effect.gen(function* () {
          registrations.set((yield* InstanceState.context).directory, services)
          yield* InstanceState.get(state)
        }),
    })
  }),
)

const registerSkills = Effect.fn("V2StandardPluginBridge.registerSkills")(function* (
  service: SkillV2.Interface,
  hooks: Hooks[],
) {
  const bundles = hooks.flatMap((hook) => hook.skill?.bundles ?? [])
  if (bundles.length === 0) return
  yield* service.transform((draft) => {
    for (const bundle of bundles) draft.bundle(bundle)
  })
})

const compatibleTools = Effect.fn("V2StandardPluginBridge.compatibleTools")(function* (
  hooks: Hooks[],
  location: { readonly directory: string; readonly worktree: string },
) {
  const definitions = new Map<string, ToolDefinition>()
  for (const hook of hooks) {
    for (const [name, definition] of Object.entries(hook.tool ?? {})) definitions.set(name, definition)
  }

  return Object.fromEntries(
    yield* Effect.forEach(
      definitions,
      Effect.fnUntraced(function* ([name, definition]) {
        const schema = pluginToolSchema(definition)
        const advertised = {
          description: definition.description,
          parameters: schema.parameters,
          jsonSchema: schema.jsonSchema as unknown,
        }
        for (const hook of hooks) {
          if (!hook["tool.definition"]) continue
          yield* Effect.tryPromise({
            try: () => hook["tool.definition"]!({ toolID: name }, advertised),
            catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
          })
        }
        return [
          name,
          Tool.make({
            description: advertised.description,
            input: Schema.Unknown,
            inputJsonSchema: advertised.jsonSchema as never,
            output: Schema.Unknown,
            authorize: (_args, context) =>
              context
                .ask({ action: name, resources: ["*"], save: ["*"], metadata: {} })
                .pipe(Effect.mapError((error) => new Tool.Failure({ message: errorMessage(error) }))),
            execute: (args, context) => execute(definition, args, context, location),
            toModelOutput: ({ output }) => legacyContent(output),
          }),
        ] as const
      }),
      { concurrency: 1 },
    ),
  )
})

const execute = Effect.fn("V2StandardPluginBridge.execute")(function* (
  definition: ToolDefinition,
  args: unknown,
  context: Tool.Context,
  location: { readonly directory: string; readonly worktree: string },
) {
  const bridge = yield* EffectBridge.make()
  const progress: Promise<void>[] = []
  const result = yield* Effect.tryPromise({
    try: (abort) =>
      definition.execute(args as never, {
        sessionID: context.sessionID,
        messageID: context.assistantMessageID,
        toolCallID: context.toolCallID,
        turnID: context.turnID,
        activityInputIDs: context.activityInputIDs,
        agent: context.agent,
        directory: location.directory,
        worktree: location.worktree,
        abort,
        metadata(input) {
          const pending = bridge.promise(
            context.progress({
              structured: { title: input.title, metadata: input.metadata ?? {} },
              content: [],
            }),
          )
          pending.catch(() => {})
          progress.push(pending)
        },
        ask(input) {
          return bridge.promise(
            context.ask({
              action: input.permission,
              resources: input.patterns,
              save: input.always,
              metadata: input.metadata,
            }),
          )
        },
      } satisfies ToolContext),
    catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
  })
  yield* Effect.tryPromise({
    try: () => Promise.all(progress),
    catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
  })
  return normalizeResult(result)
})

const registerExecutionHooks = Effect.fn("V2StandardPluginBridge.registerExecutionHooks")(function* (
  service: ToolExecution.Interface,
  hooks: Hooks[],
  pluginTools: ReadonlySet<string>,
) {
  if (!hooks.some((hook) => hook["tool.execute.before"] || hook["tool.execute.after"])) return
  yield* service.register({
    before: (invocation) =>
      Effect.gen(function* () {
        const output = { args: clone(invocation.validatedInput) }
        for (const hook of hooks) {
          if (!hook["tool.execute.before"]) continue
          yield* Effect.tryPromise({
            try: () => hook["tool.execute.before"]!(legacyInvocation(invocation), output),
            catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
          })
        }
        return output.args
      }),
    after: (invocation, value) =>
      Effect.gen(function* () {
        const original = legacyOutput(invocation.toolName, value, pluginTools.has(invocation.toolName))
        const output = clone(original)
        for (const hook of hooks) {
          if (!hook["tool.execute.after"]) continue
          yield* Effect.tryPromise({
            try: () =>
              hook["tool.execute.after"]!({ ...legacyInvocation(invocation), args: invocation.validatedInput }, output),
            catch: (error) => new Tool.Failure({ message: errorMessage(error) }),
          })
        }
        if (same(original, output)) return
        return pluginTools.has(invocation.toolName) ? pluginOutput(value, output) : genericOutput(value, output)
      }),
  })
})

const registerSystemContext = Effect.fn("V2StandardPluginBridge.registerSystemContext")(function* (
  service: SystemContextRegistry.Interface,
  hooks: Hooks[],
) {
  if (!hooks.some((hook) => hook["system.context"])) return
  yield* service.register({
    key: systemContextKey,
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
                  model: {
                    providerID: request.effectiveModel.providerID,
                    modelID: request.effectiveModel.id,
                    variant: request.effectiveModel.variant,
                  },
                },
                output,
              ),
            catch: errorMessage,
          }).pipe(Effect.orDie)
        }
        if (output.system.length === 0) return SystemContext.empty
        return SystemContext.make({
          key: systemContextKey,
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.succeed(output.system.join("\n")),
          baseline: String,
          update: (_previous, current) => current,
          removed: () => "Plugin-contributed system context no longer applies.",
        })
      }),
  })
})

function legacyInvocation(invocation: ToolExecution.Invocation) {
  return {
    tool: invocation.toolName,
    sessionID: invocation.sessionID,
    callID: invocation.toolCallID,
    agent: invocation.agent,
    activityIdentity: {
      activityID: invocation.turnID,
      inputIDs: [...invocation.activityInputIDs],
      assistantMessageID: invocation.assistantMessageID,
    },
  }
}

function normalizeResult(result: ToolResult): Record<string, unknown> {
  return typeof result === "string"
    ? { title: "", output: result, metadata: {} }
    : {
        title: result.title ?? "",
        output: result.output,
        metadata: result.metadata ?? {},
        ...(result.attachments === undefined ? {} : { attachments: result.attachments }),
      }
}

function legacyContent(value: unknown): ToolOutput["content"] {
  if (!isRecord(value)) return typeof value === "string" ? [{ type: "text", text: value }] : []
  const content: Array<ToolOutput["content"][number]> = []
  if (typeof value.output === "string") content.push({ type: "text", text: value.output })
  if (Array.isArray(value.attachments)) {
    for (const attachment of value.attachments) {
      if (!isRecord(attachment) || typeof attachment.url !== "string" || typeof attachment.mime !== "string") continue
      content.push({
        type: "file",
        uri: attachment.url,
        mime: attachment.mime,
        name: typeof attachment.filename === "string" ? attachment.filename : undefined,
      })
    }
  }
  return content
}

function legacyOutput(name: string, value: ToolOutput, pluginTool: boolean) {
  if (pluginTool && isRecord(value.structured)) {
    return {
      title: typeof value.structured.title === "string" ? value.structured.title : "",
      output: typeof value.structured.output === "string" ? value.structured.output : text(value),
      metadata: isRecord(value.structured.metadata) ? value.structured.metadata : {},
    }
  }
  return { title: name, output: text(value), metadata: isRecord(value.structured) ? value.structured : {} }
}

function pluginOutput(value: ToolOutput, output: { title: string; output: string; metadata: unknown }): ToolOutput {
  const structured = isRecord(value.structured) ? value.structured : {}
  const next = { ...structured, title: output.title, output: output.output, metadata: output.metadata }
  return { structured: next, content: legacyContent(next) }
}

function genericOutput(value: ToolOutput, output: { output: string; metadata: unknown }): ToolOutput {
  const files = value.content.filter((part) => part.type === "file")
  return {
    structured: output.metadata,
    content: [{ type: "text", text: output.output }, ...files],
  }
}

function text(value: ToolOutput): string {
  const parts = value.content.filter((part) => part.type === "text").map((part) => part.text)
  if (parts.length > 0) return parts.join("\n")
  try {
    return JSON.stringify(value.structured) ?? String(value.structured)
  } catch {
    return String(value.structured)
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function same(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Plugin.node],
})

export * as V2StandardPluginBridge from "./v2-standard-bridge"
