export * as SystemContextRegistry from "./registry"

import { Context, Effect, Layer, Ref, Scope } from "effect"
import { SystemContext } from "./index"
import { makeLocationNode } from "../effect/app-node"
import type { AgentV2 } from "../agent"
import type { ModelV2 } from "../model"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export interface Request {
  readonly session: SessionSchema.Info
  readonly agent: AgentV2.Selection
  readonly effectiveModel: ModelV2.Ref
  readonly activityInputIDs: ReadonlyArray<SessionMessage.ID>
}

export interface Entry {
  readonly key: SystemContext.Key
  readonly load:
    | Effect.Effect<SystemContext.SystemContext>
    | ((request: Request) => Effect.Effect<SystemContext.SystemContext>)
}

export interface Interface {
  readonly register: (entry: Entry) => Effect.Effect<void, never, Scope.Scope>
  readonly load: (request?: Request) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SystemContextRegistry") {}

const layer = Layer.effect(
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
          yield* Effect.forEach(
            current,
            (entry) =>
              typeof entry.load !== "function"
                ? entry.load
                : request
                  ? entry.load(request)
                  : Effect.die(`System context entry ${entry.key} requires an execution request`),
            { concurrency: "unbounded" },
          ),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
