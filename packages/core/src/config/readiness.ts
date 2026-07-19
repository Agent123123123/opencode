export * as ConfigReadiness from "./readiness"

import { Context, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"

export const Source = Schema.Literals(["agent", "provider"])
export type Source = typeof Source.Type

export interface Interface {
  readonly wait: (source: Source) => Effect.Effect<void>
  readonly complete: (source: Source, exit: Exit.Exit<void>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ConfigReadiness") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const deferred = {
      agent: yield* Deferred.make<void>(),
      provider: yield* Deferred.make<void>(),
    }
    return Service.of({
      wait: (source) => Deferred.await(deferred[source]),
      complete: (source, exit) => Deferred.done(deferred[source], exit).pipe(Effect.asVoid),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
