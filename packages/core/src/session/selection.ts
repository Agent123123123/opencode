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

export type ModelError = ModelNotSelectedError | ModelUnavailableError | ModelUnsupportedError | VariantNotFoundError

export type Selection = {
  readonly agent: AgentV2.ID
  readonly model: ModelV2.Ref
}

type SelectionInput = {
  readonly agent?: AgentV2.ID
  readonly model?: ModelV2.Ref
}

type ConfiguredSelectionInput = {
  readonly agent?: AgentV2.ID
  readonly model: ModelV2.Ref
}

export interface Interface {
  readonly resolve: (input: SelectionInput) => Effect.Effect<Selection, Error>
  readonly resolveModel: (model?: ModelV2.Ref) => Effect.Effect<ModelV2.Ref, ModelError>
  readonly resolveConfigured: (input: ConfiguredSelectionInput) => Effect.Effect<Selection, Error>
  readonly resolveConfiguredModel: (model: ModelV2.Ref) => Effect.Effect<ModelV2.Ref, ModelError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionSelection") {}

/** Test or embedding seam for supplying location selection resolvers directly. */
export const layerWith = (input: Pick<Interface, "resolve" | "resolveConfigured">) =>
  Layer.succeed(
    Service,
    Service.of({
      resolve: input.resolve,
      resolveModel: (model) =>
        input.resolve({ model }).pipe(
          Effect.catchTags({
            "SessionSelection.AgentNotFoundError": Effect.die,
            "SessionSelection.AgentUnavailableError": Effect.die,
          }),
          Effect.map((selection) => selection.model),
        ),
      resolveConfigured: input.resolveConfigured,
      resolveConfiguredModel: (model) =>
        input.resolveConfigured({ model }).pipe(
          Effect.catchTags({
            "SessionSelection.AgentNotFoundError": Effect.die,
            "SessionSelection.AgentUnavailableError": Effect.die,
          }),
          Effect.map((selection) => selection.model),
        ),
    }),
  )

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const catalog = yield* Catalog.Service
    const readiness = yield* ConfigReadiness.Service

    const validateModel = Effect.fn("SessionSelection.validateModel")(function* (
      requested: ModelV2.Ref | undefined,
      model: ModelV2.Info,
    ) {
      const ref = ModelV2.Ref.make({
        id: model.id,
        providerID: model.providerID,
        variant: requested?.variant ?? ModelV2.VariantID.make("default"),
      })
      if (!SessionModelSupport.supported(model)) return yield* new ModelUnsupportedError({ model: ref })
      if (ref.variant !== "default" && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new VariantNotFoundError({ model: ref })
      return ref
    })

    const resolveModel = Effect.fn("SessionSelection.resolveModel")(function* (requested?: ModelV2.Ref) {
      yield* readiness.wait("provider")
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

      return yield* validateModel(requested, model)
    })

    const resolveConfiguredModel = Effect.fn("SessionSelection.resolveConfiguredModel")(function* (
      requested: ModelV2.Ref,
    ) {
      yield* readiness.wait("provider")
      const provider = yield* catalog.provider.get(requested.providerID)
      const model = yield* catalog.model.get(requested.providerID, requested.id)
      if (!provider || provider.disabled || !model?.enabled) return yield* new ModelUnavailableError({ model: requested })
      return yield* validateModel(requested, model)
    })

    const resolveAgent = Effect.fn("SessionSelection.resolveAgent")(function* (requested?: AgentV2.ID) {
      const selectedAgent = yield* agents.select(requested)
      const info = selectedAgent.info
      if (!info) return yield* new AgentNotFoundError({ agent: selectedAgent.id })
      // Hidden controls discovery/default selection, not explicit addressability. Embedders
      // may create sessions for a configured hidden primary agent when they know its exact ID.
      if (info.mode === "subagent" || (requested === undefined && info.hidden))
        return yield* new AgentUnavailableError({ agent: selectedAgent.id })
      return { id: selectedAgent.id, info }
    })

    return Service.of({
      resolveModel,
      resolveConfiguredModel,
      resolve: Effect.fn("SessionSelection.resolve")(function* (input) {
        // Config plugins are loaded asynchronously with the rest of the location runtime. A
        // selection made before either commit would validate against a partial catalog.
        yield* readiness.wait("agent")
        const selectedAgent = yield* resolveAgent(input.agent)
        return { agent: selectedAgent.id, model: yield* resolveModel(input.model ?? selectedAgent.info.model) }
      }),
      resolveConfigured: Effect.fn("SessionSelection.resolveConfigured")(function* (input) {
        yield* readiness.wait("agent")
        const selectedAgent = yield* resolveAgent(input.agent)
        return { agent: selectedAgent.id, model: yield* resolveConfiguredModel(input.model) }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [AgentV2.node, Catalog.node, ConfigReadiness.node],
})
