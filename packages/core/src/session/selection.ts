export * as SessionSelection from "./selection"

import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { ConfigReadiness } from "../config/readiness"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SessionModelSupport } from "./model-support"

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()(
  "SessionSelection.AgentNotFoundError",
  { agent: AgentV2.ID },
) {}

export class AgentUnavailableError extends Schema.TaggedErrorClass<AgentUnavailableError>()(
  "SessionSelection.AgentUnavailableError",
  { agent: AgentV2.ID },
) {}

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionSelection.ModelNotSelectedError",
  {},
) {}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionSelection.ModelUnavailableError",
  { model: ModelV2.Ref },
) {}

export class ModelUnsupportedError extends Schema.TaggedErrorClass<ModelUnsupportedError>()(
  "SessionSelection.ModelUnsupportedError",
  { model: ModelV2.Ref },
) {}

export class VariantNotFoundError extends Schema.TaggedErrorClass<VariantNotFoundError>()(
  "SessionSelection.VariantNotFoundError",
  { model: ModelV2.Ref },
) {}

export type Error =
  | AgentNotFoundError
  | AgentUnavailableError
  | ModelNotSelectedError
  | ModelUnavailableError
  | ModelUnsupportedError
  | VariantNotFoundError

export type Selection = {
  readonly agent: AgentV2.ID
  readonly model: ModelV2.Ref
}

export interface Interface {
  readonly resolve: (input: {
    readonly agent?: AgentV2.ID
    readonly model?: ModelV2.Ref
  }) => Effect.Effect<Selection, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionSelection") {}

/** Test or embedding seam for supplying a location selection resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const catalog = yield* Catalog.Service
    const readiness = yield* ConfigReadiness.Service

    return Service.of({
      resolve: Effect.fn("SessionSelection.resolve")(function* (input) {
        // Config plugins are loaded asynchronously with the rest of the location runtime. A
        // selection made before either commit would validate against a partial catalog.
        yield* Effect.all([readiness.wait("agent"), readiness.wait("provider")], {
          discard: true,
          concurrency: "unbounded",
        })

        const selectedAgent = yield* agents.select(input.agent)
        if (!selectedAgent.info) return yield* new AgentNotFoundError({ agent: selectedAgent.id })
        if (selectedAgent.info.hidden || selectedAgent.info.mode === "subagent")
          return yield* new AgentUnavailableError({ agent: selectedAgent.id })

        const requested = input.model ?? selectedAgent.info.model
        const available = yield* catalog.model.available()
        let model: ModelV2.Info | undefined
        if (requested) {
          model = available.find((item) => item.providerID === requested.providerID && item.id === requested.id)
          if (!model) return yield* new ModelUnavailableError({ model: requested })
        } else {
          const preferred = yield* catalog.model.default()
          model =
            (preferred &&
            available.some((item) => item.providerID === preferred.providerID && item.id === preferred.id) &&
            SessionModelSupport.supported(preferred)
              ? preferred
              : undefined) ?? available.find(SessionModelSupport.supported)
          if (!model) return yield* new ModelNotSelectedError()
        }

        const ref = ModelV2.Ref.make({
          id: model.id,
          providerID: model.providerID,
          variant: requested?.variant ?? ModelV2.VariantID.make("default"),
        })
        if (!SessionModelSupport.supported(model)) return yield* new ModelUnsupportedError({ model: ref })
        if (ref.variant !== "default" && !model.variants.some((variant) => variant.id === ref.variant))
          return yield* new VariantNotFoundError({ model: ref })

        return { agent: selectedAgent.id, model: ref }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [AgentV2.node, Catalog.node, ConfigReadiness.node],
})
