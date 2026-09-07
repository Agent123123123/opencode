import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("/managed-preflight-test")
const providerID = ProviderV2.ID.make("preflight-provider")
const modelID = ModelV2.ID.make("preflight-model")
const integrationID = Integration.ID.make("preflight-provider")
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  SessionRunnerModel.node, Catalog.node, Integration.node, Credential.node,
]), [
  [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
]))

const session = SessionV2.Info.make({
  id: SessionV2.ID.make("ses_managed_preflight"),
  projectID: ProjectV2.ID.global,
  title: "managed preflight",
  model: { providerID, id: modelID },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory },
  execution: { managed: true, gateOpen: true },
})

const configure = Effect.gen(function* () {
  const integration = yield* Integration.Service
  yield* integration.transform((editor) => editor.update(integrationID, () => {}))
  const catalog = yield* Catalog.Service
  yield* catalog.transform((editor) => {
    editor.provider.update(providerID, (provider) => { provider.integrationID = integrationID })
    editor.model.update(providerID, modelID, (model) => {
      model.enabled = true
      model.api = { id: modelID, type: "aisdk", package: "@ai-sdk/openai", url: "https://preflight.invalid/v1" }
    })
  })
  return { catalog, resolver: yield* SessionRunnerModel.Service }
})

describe("managed provider preflight against the real Catalog", () => {
  it.effect("distinguishes missing credentials and resolves after a local credential is supplied without probing the network", () =>
    Effect.gen(function* () {
      const { catalog, resolver } = yield* configure
      expect(yield* catalog.model.available()).toEqual([])
      expect(yield* resolver.resolve(session).pipe(Effect.flip)).toBeInstanceOf(
        SessionRunnerModel.ProviderConnectionRequiredError,
      )
      const credentials = yield* Credential.Service
      yield* credentials.create({ integrationID, value: Credential.Key.make({ type: "key", key: "test-only-key" }) })
      expect(yield* resolver.resolve(session)).toMatchObject({ id: modelID, provider: providerID })
    }),
  )

  it.effect("does not report disabled or deleted configuration as a missing provider connection", () =>
    Effect.gen(function* () {
      const { catalog, resolver } = yield* configure
      yield* catalog.transform((editor) => editor.provider.update(providerID, (provider) => { provider.disabled = true }))
      expect(yield* resolver.resolve(session).pipe(Effect.flip)).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      yield* catalog.transform((editor) => {
        editor.provider.update(providerID, (provider) => { provider.disabled = false })
        editor.model.update(providerID, modelID, (model) => { model.enabled = false })
      })
      expect(yield* resolver.resolve(session).pipe(Effect.flip)).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      yield* catalog.transform((editor) => editor.model.remove(providerID, modelID))
      expect(yield* resolver.resolve(session).pipe(Effect.flip)).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
    }),
  )

  it.effect("validates the selected variant before suggesting that credentials alone will repair execution", () =>
    Effect.gen(function* () {
      const { resolver } = yield* configure
      const invalid = SessionV2.Info.make({
        ...session,
        model: { providerID, id: modelID, variant: ModelV2.VariantID.make("does-not-exist") },
      })
      expect(yield* resolver.resolve(invalid).pipe(Effect.flip)).toBeInstanceOf(SessionRunnerModel.VariantUnavailableError)
    }),
  )
})
