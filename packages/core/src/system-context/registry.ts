export * as SystemContextRegistry from "./registry"

import { Context, Effect, Layer, Ref, Scope } from "effect"
import { SystemContext } from "./index"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"

export interface Request {
  readonly session: SessionSchema.Info
  readonly agent: AgentV2.Selection
  readonly activityInputIDs: ReadonlyArray<SessionMessage.ID>
  readonly effectiveModel?: ModelV2.Ref
}

export interface Entry {
  readonly key: SystemContext.Key
  readonly load: (request: Request) => Effect.Effect<SystemContext.SystemContext>
}

export interface Interface {
  readonly register: (entry: Entry) => Effect.Effect<void, never, Scope.Scope>
  readonly load: (request: Request) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SystemContextRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<Entry>>([])

    return Service.of({
      register: Effect.fn("SystemContextRegistry.register")(function* (entry) {
        yield* Effect.acquireRelease(
          Ref.modify(entries, (current) => {
            if (current.some((item) => item.key === entry.key)) return [false, current]
            return [true, [...current, entry]]
          }).pipe(
            Effect.flatMap((added) =>
              added ? Effect.void : Effect.die(`Duplicate system context entry key: ${entry.key}`),
            ),
            Effect.as(entry),
          ),
          (entry) => Ref.update(entries, (current) => current.filter((item) => item !== entry)),
        )
      }),
      load: Effect.fn("SystemContextRegistry.load")(function* (request) {
        const current = (yield* Ref.get(entries)).toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return SystemContext.combine(
          yield* Effect.forEach(current, (entry) => entry.load(request), { concurrency: "unbounded" }),
        )
      }),
    })
  }),
)
