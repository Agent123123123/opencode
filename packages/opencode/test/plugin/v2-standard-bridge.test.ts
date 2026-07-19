import { expect, test } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { SystemContext } from "@opencode-ai/core/system-context/index"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ToolExecution } from "@opencode-ai/core/tool/execution"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import type { Hooks } from "@opencode-ai/plugin"
import { Effect, Fiber, Layer, Scope } from "effect"
import { z } from "zod"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Plugin } from "../../src/plugin"
import { V2StandardPluginBridge } from "../../src/plugin/v2-standard-bridge"

test("standard hooks bridge V1 tools into V2 with real execution capabilities", async () => {
  const trace: string[] = []
  const hookActivityIDs: Array<string | undefined> = []
  const tools: Record<string, Tool.AnyTool> = {}
  let policy: ToolExecution.Policy | undefined
  let systemEntry: SystemContextRegistry.Entry | undefined
  let startWaits!: () => void
  let abortFirstWait!: () => void
  let abortSecondWait!: () => void
  const waitsStarted = new Promise<void>((resolve) => (startWaits = resolve))
  const firstWaitAborted = new Promise<void>((resolve) => (abortFirstWait = resolve))
  const secondWaitAborted = new Promise<void>((resolve) => (abortSecondWait = resolve))
  const abortedWaits: number[] = []
  let waiting = 0

  const hooks: Hooks = {
    tool: {
      bridge_echo: {
        description: "bridge echo",
        args: { text: z.string() },
        async execute(args, context) {
          const text = String(args.text)
          trace.push(`execute:${text}`)
          context.metadata({ title: "working", metadata: { text } })
          await context.ask({ permission: "fine_grained", patterns: [text], always: [], metadata: {} })
          return { title: "echo", output: `${context.sessionID}:${text}`, metadata: { complete: true } }
        },
      },
      bridge_wait: {
        description: "bridge wait",
        args: {},
        execute: async (_args, context) => {
          const index = waiting++
          if (waiting === 2) startWaits()
          return new Promise<string>((_resolve, reject) => {
            context.abort.addEventListener(
              "abort",
              () => {
                trace.push("abort:bridge_wait")
                abortedWaits.push(index)
                if (index === 0) abortFirstWait()
                if (index === 1) abortSecondWait()
                reject(context.abort.reason)
              },
              { once: true },
            )
          })
        },
      },
    },
    "tool.definition": async (input, output) => {
      if (input.toolID !== "bridge_echo") return
      output.description = "advertised echo"
    },
    "tool.execute.before": async (input, output) => {
      hookActivityIDs.push(input.activityIdentity?.activityID)
      const args = output.args as { text?: string }
      trace.push(`before:${input.tool}:${args.text ?? ""}`)
      if (input.tool === "bridge_echo") args.text = `${args.text}-hook`
    },
    "tool.execute.after": async (input, output) => {
      trace.push(`after:${input.tool}`)
      output.output += "-after"
    },
    "system.context": async (input, output) => {
      output.system.push(
        `context:${input.sessionID}:${input.agentID}:${input.activityInputIDs.join(",")}:${input.model?.modelID}`,
      )
    },
  }

  const pluginLayer = Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([hooks]),
      trigger: ((_name: unknown, _input: unknown, output: unknown) =>
        Effect.succeed(output)) as Plugin.Interface["trigger"],
    }),
  )
  const executionService = ToolExecution.Service.of({
    register: (registered) =>
      Effect.gen(function* () {
        policy = registered
        yield* Effect.addFinalizer(() => Effect.void)
      }),
    before: (invocation) =>
      policy?.before?.(invocation).pipe(Effect.map((replacement) => replacement ?? invocation.validatedInput)) ??
      Effect.succeed(invocation.validatedInput),
    after: (invocation, output) =>
      policy?.after?.(invocation, output).pipe(Effect.map((replacement) => replacement ?? output)) ??
      Effect.succeed(output),
  })
  const locationLayer = Layer.mergeAll(
    Layer.succeed(
      Tools.Service,
      Tools.Service.of({
        register: (registered) =>
          Effect.gen(function* () {
            Object.assign(tools, registered)
            yield* Effect.addFinalizer(() => Effect.void)
          }),
      }),
    ),
    Layer.succeed(ToolExecution.Service, executionService),
    Layer.succeed(
      SystemContextRegistry.Service,
      SystemContextRegistry.Service.of({
        register: (entry) =>
          Effect.gen(function* () {
            systemEntry = entry
            yield* Effect.addFinalizer(() => Effect.void)
          }),
        load: () => Effect.succeed(SystemContext.empty),
      }),
    ),
  )
  const locationMap = LocationServiceMap.Service.of({ get: () => locationLayer } as never)
  const mapLayer = Layer.succeed(LocationServiceMap.Service, locationMap)
  const bridgeLayer = V2StandardPluginBridge.layer.pipe(Layer.provide(pluginLayer), Layer.provide(mapLayer))
  const instance = {
    directory: "/project",
    worktree: "/project",
    project: { id: "project", worktree: "/project", time: { created: 0, updated: 0 }, sandboxes: [] },
  } as never

  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const services = {
          tools: yield* Tools.Service,
          execution: yield* ToolExecution.Service,
          contexts: yield* SystemContextRegistry.Service,
        }
        yield* V2StandardPluginBridge.Service.use((bridge) => bridge.init(services))
      }).pipe(Effect.provideService(InstanceRef, instance), Effect.provide(locationLayer))
      expect(Object.keys(tools).sort()).toEqual(["bridge_echo", "bridge_wait"])
      expect(Tool.definition("bridge_echo", tools.bridge_echo).description).toBe("advertised echo")
      expect(Tool.definition("bridge_echo", tools.bridge_echo).inputSchema).toMatchObject({
        type: "object",
        required: ["text"],
      })

      const execution = executionService
      const progress: unknown[] = []
      const context: Tool.Context = {
        sessionID: SessionV2.ID.make("ses_bridge"),
        agent: AgentV2.ID.make("analyst"),
        turnID: SessionMessage.ID.make("msg_turn_bridge"),
        assistantMessageID: SessionMessage.ID.make("msg_bridge"),
        activityInputIDs: [SessionMessage.ID.make("msg_input")],
        toolCallID: "call_bridge",
        abort: new AbortController().signal,
        progress: (output) => Effect.sync(() => progress.push(output)),
        ask: (input) => Effect.sync(() => trace.push(`ask:${input.action}:${input.resources.join(",")}`)),
      }
      const output = yield* Tool.settle(
        tools.bridge_echo,
        "bridge_echo",
        { type: "tool-call", id: "call_bridge", name: "bridge_echo", input: { text: "hello" } },
        context,
        execution,
      )
      expect(output).toMatchObject({
        structured: {
          title: "echo",
          output: "ses_bridge:hello-hook-after",
          metadata: { complete: true },
        },
        content: [{ type: "text", text: "ses_bridge:hello-hook-after" }],
      })
      expect(progress).toEqual([{ structured: { title: "working", metadata: { text: "hello-hook" } }, content: [] }])
      expect(trace).toEqual([
        "ask:bridge_echo:*",
        "before:bridge_echo:hello",
        "ask:bridge_echo:*",
        "execute:hello-hook",
        "ask:fine_grained:hello-hook",
        "after:bridge_echo",
      ])
      expect(hookActivityIDs).toEqual([context.turnID])

      if (!systemEntry || typeof systemEntry.load !== "function") return yield* Effect.die("missing system entry")
      const system = yield* systemEntry.load({
        session: { id: context.sessionID } as never,
        agent: { id: context.agent, info: undefined },
        effectiveModel: {
          providerID: ProviderV2.ID.make("provider"),
          id: ModelV2.ID.make("model"),
          variant: ModelV2.VariantID.make("strong"),
        },
        activityInputIDs: context.activityInputIDs,
      })
      expect((yield* SystemContext.initialize(system)).baseline).toBe("context:ses_bridge:analyst:msg_input:model")

      const wait = (callID: string) =>
        Tool.settle(
          tools.bridge_wait,
          "bridge_wait",
          { type: "tool-call", id: callID, name: "bridge_wait", input: {} },
          { ...context, toolCallID: callID },
          execution,
        )
      const first = yield* Effect.forkChild(wait("call_wait_first"))
      const second = yield* Effect.forkChild(wait("call_wait_second"))
      yield* Effect.promise(() => waitsStarted)
      yield* Fiber.interrupt(first)
      yield* Effect.promise(() => firstWaitAborted)
      expect(abortedWaits).toEqual([0])
      yield* Fiber.interrupt(second)
      yield* Effect.promise(() => secondWaitAborted)
      expect(abortedWaits).toEqual([0, 1])
    }).pipe(Effect.provide(bridgeLayer), Effect.scoped),
  )
})
