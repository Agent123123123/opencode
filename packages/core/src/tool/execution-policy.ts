export * as ToolExecutionPolicy from "./execution-policy"

import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { Location } from "../location"
import { Failure, type Context as ToolContext } from "./tool"

export interface Invocation {
  readonly location: Location.Info
  readonly sessionID: ToolContext["sessionID"]
  readonly agent: ToolContext["agent"]
  readonly turnID: ToolContext["turnID"]
  readonly assistantMessageID: ToolContext["assistantMessageID"]
  readonly activityInputIDs: ReadonlyArray<NonNullable<ToolContext["activityInputIDs"]>[number]>
  readonly toolCallID: ToolContext["toolCallID"]
  readonly toolName: string
  readonly validatedInput: unknown
}

export interface Policy {
  readonly before?: (invocation: Invocation) => Effect.Effect<unknown | void, Failure>
  readonly after?: (invocation: Invocation, output: unknown) => Effect.Effect<unknown | void, Failure>
  readonly failure?: (invocation: Invocation, cause: Cause.Cause<unknown>) => Effect.Effect<void>
}

export interface Interface {
  readonly register: (policy: Policy) => Effect.Effect<void, never, Scope.Scope>
  readonly execute: <A>(
    input: Omit<Invocation, "location" | "validatedInput"> & { readonly validatedInput: unknown },
    execute: (validatedInput: unknown) => Effect.Effect<A, Failure>,
  ) => Effect.Effect<A, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolExecutionPolicy") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const policies: Array<{ readonly token: object; readonly policy: Policy }> = []

    return Service.of({
      register: Effect.fn("ToolExecutionPolicy.register")(function* (policy) {
        const token = {}
        policies.push({ token, policy })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const index = policies.findIndex((entry) => entry.token === token)
            if (index >= 0) policies.splice(index, 1)
          }),
        )
      }),
      execute: Effect.fn("ToolExecutionPolicy.execute")(function* (input, execute) {
        const active = policies.map((entry) => entry.policy)
        let invocation: Invocation = { ...input, location }
        const program = Effect.gen(function* () {
          for (const policy of active) {
            if (!policy.before) continue
            const replacement = yield* policy.before(invocation)
            if (replacement !== undefined) invocation = { ...invocation, validatedInput: replacement }
          }
          return yield* execute(invocation.validatedInput)
        })
        const exit = yield* Effect.exit(program)
        if (Exit.isFailure(exit)) {
          yield* Effect.forEach(
            active,
            (policy) => policy.failure?.(invocation, exit.cause) ?? Effect.void,
            { concurrency: 1, discard: true },
          )
          return yield* Effect.failCause(exit.cause)
        }
        let output: unknown = exit.value
        for (const policy of active) {
          if (!policy.after) continue
          const replacement = yield* policy.after(invocation, output)
          if (replacement !== undefined) output = replacement
        }
        return output as typeof exit.value
      }),
    })
  }),
)

/** Standalone Core/test graph with no contributed execution policies. */
export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    register: () => Effect.addFinalizer(() => Effect.void),
    execute: (input, execute) => execute(input.validatedInput),
  }),
)
