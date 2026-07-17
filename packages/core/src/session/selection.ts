export * as SessionSelection from "./selection"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { ModelV2 } from "../model"
import { PluginBoot } from "../plugin/boot"
import { SessionModelSupport } from "./model-support"

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()(
  "SessionSelection.AgentNotFoundError",
  { agent: AgentV2.ID },
) {}

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionSelection.ModelNotSelectedError",
  {},
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
  | ModelNotSelectedError
  | ModelUnsupportedError
  | VariantNotFoundError
  | Catalog.ProviderNotFoundError
  | Catalog.ModelNotFoundError

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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const catalog = yield* Catalog.Service
    const boot = yield* PluginBoot.Service

    return Service.of({
      resolve: Effect.fn("SessionSelection.resolve")(function* (input) {
        yield* boot.wait()
        const agent = yield* agents.select(input.agent)
        if (!agent.info) return yield* new AgentNotFoundError({ agent: agent.id })
        const requested = input.model ?? agent.info.model
        const model = requested
          ? yield* catalog.model.get(requested.providerID, requested.id)
          : (Option.getOrUndefined(
              (yield* catalog.model.default()).pipe(Option.filter(SessionModelSupport.supported)),
            ) ?? (yield* catalog.model.available()).find(SessionModelSupport.supported))
        if (!model) return yield* new ModelNotSelectedError()
        const ref: ModelV2.Ref = {
          ...(requested ?? { id: model.id, providerID: model.providerID }),
          variant: requested?.variant ?? ModelV2.VariantID.make(model.request.variant ?? "default"),
        }
        if (!SessionModelSupport.supported(model)) return yield* new ModelUnsupportedError({ model: ref })
        if (
          ref.variant !== undefined &&
          ref.variant !== "default" &&
          !model.variants.some((variant) => variant.id === ref.variant)
        )
          return yield* new VariantNotFoundError({ model: ref })
        return { agent: agent.id, model: ref }
      }),
    })
  }),
)

export const locationLayer = layer
