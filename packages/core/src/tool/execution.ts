export * as ToolExecution from "./execution"

import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import type { ToolOutput } from "@opencode-ai/llm"
import type { Failure, Context as ToolContext } from "./tool"

export interface Invocation {
  readonly sessionID: ToolContext["sessionID"]
  readonly agent: ToolContext["agent"]
  readonly assistantMessageID: ToolContext["assistantMessageID"]
  readonly activityInputIDs: ToolContext["activityInputIDs"]
  readonly toolCallID: ToolContext["toolCallID"]
  readonly toolName: string
  readonly validatedInput: unknown
}

/**
 * Location-scoped execution observers. A policy runs only after the tool's
 * ordinary authorization phase has completed. Returning replacement arguments
 * causes the tool to authorize those arguments again before execution.
 */
export interface Policy {
  readonly before?: (invocation: Invocation) => Effect.Effect<unknown, Failure>
  readonly after?: (invocation: Invocation, output: ToolOutput) => Effect.Effect<ToolOutput | void, Failure>
}

export interface Interface {
  readonly register: (policy: Policy) => Effect.Effect<void, never, Scope.Scope>
  readonly before: (invocation: Omit<Invocation, "location">) => Effect.Effect<unknown, Failure>
  readonly after: (invocation: Omit<Invocation, "location">, output: ToolOutput) => Effect.Effect<ToolOutput, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolExecution") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const policies: Array<{ readonly token: object; readonly policy: Policy }> = []

    return Service.of({
      register: Effect.fn("ToolExecution.register")(function* (policy) {
        const token = {}
        policies.push({ token, policy })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const index = policies.findIndex((entry) => entry.token === token)
            if (index >= 0) policies.splice(index, 1)
          }),
        )
      }),
      before: Effect.fn("ToolExecution.before")(function* (input) {
        const invocation: Invocation = input
        let result: unknown = input.validatedInput
        for (const { policy } of [...policies]) {
          if (!policy.before) continue
          result = yield* policy.before({ ...invocation, validatedInput: result })
        }
        return result
      }),
      after: Effect.fn("ToolExecution.after")(function* (input, initial) {
        const invocation: Invocation = input
        let output = initial
        for (const { policy } of [...policies]) {
          if (!policy.after) continue
          const replacement = yield* policy.after(invocation, output)
          if (replacement !== undefined) output = replacement
        }
        return output
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [],
})
