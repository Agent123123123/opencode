import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionSelection } from "@opencode-ai/core/session/selection"
import { Effect, Layer, LayerMap } from "effect"

const fallbackModel = ModelV2.Ref.make({
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test-provider"),
  variant: ModelV2.VariantID.make("default"),
})

export const echoSessionSelection = SessionSelection.layerWith((input) =>
  Effect.succeed({
    agent: input.agent ?? AgentV2.ID.make("build"),
    model: ModelV2.Ref.make({
      ...(input.model ?? fallbackModel),
      variant: input.model?.variant ?? fallbackModel.variant,
    }),
  }),
)

/** A narrow LocationServiceMap fixture for Session tests that only exercise create selection. */
export const sessionSelectionLocations = Layer.effect(
  LocationServiceMap.Service,
  // This deliberately provides only the service SessionV2.create consumes. Keeping the
  // fixture narrow prevents unit tests from booting a real filesystem-backed location graph.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  LayerMap.make((_ref: Location.Ref) => echoSessionSelection) as unknown as Effect.Effect<
    LayerMap.LayerMap<Location.Ref, LocationServices>
  >,
)
