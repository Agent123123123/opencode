import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolExecution } from "@opencode-ai/core/tool/execution"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, ToolExecution.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const identity = {
  sessionID: SessionV2.ID.make("ses_tool_execution"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_execution"),
}

describe("ToolExecution", () => {
  it.effect("authorizes before hooks and reauthorizes hook replacements before execution", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const execution = yield* ToolExecution.Service
      const order: string[] = []
      yield* execution.register({
        before: (invocation) =>
          Effect.sync(() => {
            const value = (invocation.validatedInput as { value: string }).value
            order.push(`before:${value}`)
            return { value: `${value}-hook` }
          }),
        after: (_invocation, output) =>
          Effect.sync(() => {
            order.push("after")
            return {
              structured: output.structured,
              content: [
                { type: "text", text: `${output.content[0]?.type === "text" ? output.content[0].text : ""}-after` },
              ],
            }
          }),
      })
      yield* registry.register({
        guarded: Tool.make({
          description: "guarded",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          authorize: (input) => Effect.sync(() => order.push(`authorize:${input.value}`)),
          execute: (input) => Effect.sync(() => order.push(`execute:${input.value}`)).pipe(Effect.as(input.value)),
        }),
      })

      expect(
        yield* settleTool(registry, {
          ...identity,
          call: { type: "tool-call", id: "call-guarded", name: "guarded", input: { value: "original" } },
        }),
      ).toMatchObject({ result: { type: "text", value: "original-hook-after" } })
      expect(order).toEqual([
        "authorize:original",
        "before:original",
        "authorize:original-hook",
        "execute:original-hook",
        "after",
      ])
    }),
  )

  it.effect("keeps ordinary tools on the direct path when no policy is registered", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      let executions = 0
      yield* registry.register({
        direct: Tool.make({
          description: "direct",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          execute: (input) => Effect.sync(() => executions++).pipe(Effect.as(input.value)),
        }),
      })
      expect(
        yield* settleTool(registry, {
          ...identity,
          call: { type: "tool-call", id: "call-direct", name: "direct", input: { value: "unchanged" } },
        }),
      ).toMatchObject({ result: { type: "text", value: "unchanged" } })
      expect(executions).toBe(1)
    }),
  )

  it.effect("does not invoke execution hooks or tool side effects when authorization fails", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const execution = yield* ToolExecution.Service
      const order: string[] = []
      yield* execution.register({
        before: () => Effect.sync(() => order.push("before")),
        after: () =>
          Effect.sync(() => {
            order.push("after")
          }),
      })
      yield* registry.register({
        denied: Tool.make({
          description: "denied",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          authorize: () =>
            Effect.sync(() => order.push("authorize")).pipe(
              Effect.andThen(new Tool.Failure({ message: "denied by ordinary permission" })),
            ),
          execute: (input) => Effect.sync(() => order.push("execute")).pipe(Effect.as(input.value)),
        }),
      })

      expect(
        yield* settleTool(registry, {
          ...identity,
          call: { type: "tool-call", id: "call-denied", name: "denied", input: { value: "blocked" } },
        }),
      ).toMatchObject({ result: { type: "error", value: "denied by ordinary permission" } })
      expect(order).toEqual(["authorize"])
    }),
  )
})
