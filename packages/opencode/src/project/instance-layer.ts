import { Effect, Layer } from "effect"
import { InstanceStore } from "./instance-store"
import { LocationServiceMap, LocationServiceMapLive } from "@opencode-ai/core/location-layer"

export const sharedLayer = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    return InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.sharedDefaultLayer))
  }),
)

export const layer = sharedLayer.pipe(Layer.provide(LocationServiceMapLive))

export * as InstanceLayer from "./instance-layer"
