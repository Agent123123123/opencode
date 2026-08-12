import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { ConfigReadiness } from "@opencode-ai/core/config/readiness"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionSelection } from "@opencode-ai/core/session/selection"
import { Effect, Layer } from "effect"
import { it } from "./lib/effect"

const providerID = ProviderV2.ID.make("test-provider")
const modelID = ModelV2.ID.make("test-model")
const model = (options: { supported?: boolean; variants?: string[] } = {}) =>
  ModelV2.Info.make({
    id: modelID,
    providerID,
    name: "Test model",
    api:
      options.supported === false
        ? { id: modelID, type: "native", settings: {} }
        : { id: modelID, type: "aisdk", package: "@ai-sdk/openai", settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: (options.variants ?? []).map((id) => ({
      id: ModelV2.VariantID.make(id),
      headers: {},
      body: {},
    })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 10_000, output: 1_000 },
  })

const agent = (id: string, options: { hidden?: boolean; mode?: "all" | "primary" | "subagent" } = {}) =>
  AgentV2.Info.make({
    ...AgentV2.Info.empty(AgentV2.ID.make(id)),
    hidden: options.hidden ?? false,
    mode: options.mode ?? "all",
  })

function layer(options: {
  agents?: AgentV2.Info[]
  models?: ModelV2.Info[]
  defaultModel?: ModelV2.Info
  waited?: ConfigReadiness.Source[]
}) {
  const entries = options.agents ?? [agent("build")]
  const agents = Layer.mock(AgentV2.Service, {
    select: (id?: string) => {
      const selected = AgentV2.ID.make(id ?? "build")
      return Effect.succeed({ id: selected, info: entries.find((item) => item.id === selected) })
    },
  })
  const catalog = Layer.mock(Catalog.Service, {
    provider: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.succeed(undefined),
      all: () => Effect.succeed(options.models ?? [model()]),
      available: () => Effect.succeed(options.models ?? [model()]),
      default: () => Effect.succeed(options.defaultModel ?? (options.models ?? [model()])[0]),
      small: () => Effect.succeed(undefined),
    },
  })
  const readiness = Layer.mock(ConfigReadiness.Service, {
    wait: (id) => Effect.sync(() => options.waited?.push(id)),
  })
  return SessionSelection.locationLayer.pipe(Layer.provide(Layer.mergeAll(agents, catalog, readiness)))
}

const resolve = (input: Parameters<SessionSelection.Interface["resolve"]>[0]) =>
  SessionSelection.Service.use((service) => service.resolve(input))
const resolveModel = (input: Parameters<SessionSelection.Interface["resolveModel"]>[0]) =>
  SessionSelection.Service.use((service) => service.resolveModel(input))

describe("SessionSelection", () => {
  it.effect("waits for config and resolves an exact default tuple", () =>
    Effect.gen(function* () {
      const waited: ConfigReadiness.Source[] = []
      const selected = yield* resolve({}).pipe(Effect.provide(layer({ waited })))

      expect(new Set(waited)).toEqual(new Set<ConfigReadiness.Source>(["agent", "provider"]))
      expect(selected).toEqual({
        agent: AgentV2.ID.make("build"),
        model: ModelV2.Ref.make({
          providerID,
          id: modelID,
          variant: ModelV2.VariantID.make("default"),
        }),
      })
    }),
  )

  it.effect("rejects unknown agents and explicit subagents", () =>
    Effect.gen(function* () {
      for (const [agents, id, tag] of [
        [[agent("build")], "missing", "SessionSelection.AgentNotFoundError"],
        [[agent("child", { mode: "subagent" })], "child", "SessionSelection.AgentUnavailableError"],
      ] as const) {
        expect(
          yield* resolve({ agent: AgentV2.ID.make(id) }).pipe(
            Effect.provide(layer({ agents: [...agents] })),
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
        ).toBe(tag)
      }
    }),
  )

  it.effect("allows an explicitly addressed hidden primary agent", () =>
    Effect.gen(function* () {
      const selected = yield* resolve({ agent: AgentV2.ID.make("hidden") }).pipe(
        Effect.provide(layer({ agents: [agent("hidden", { hidden: true, mode: "primary" })] })),
      )

      expect(selected).toEqual({
        agent: AgentV2.ID.make("hidden"),
        model: ModelV2.Ref.make({
          providerID,
          id: modelID,
          variant: ModelV2.VariantID.make("default"),
        }),
      })
    }),
  )

  it.effect("validates a model independently of existing Session agent selectability", () =>
    Effect.gen(function* () {
      const waited: ConfigReadiness.Source[] = []
      const selected = yield* resolveModel(ModelV2.Ref.make({ providerID, id: modelID })).pipe(
        Effect.provide(layer({ agents: [agent("child", { mode: "subagent" })], waited })),
      )

      expect(selected).toEqual(
        ModelV2.Ref.make({
          providerID,
          id: modelID,
          variant: ModelV2.VariantID.make("default"),
        }),
      )
      expect(waited).toEqual(["provider"])
    }),
  )

  it.effect("rejects unavailable, unsupported, and unknown-variant models", () =>
    Effect.gen(function* () {
      const requested = ModelV2.Ref.make({ providerID, id: modelID })
      const cases = [
        { models: [], model: requested, tag: "SessionSelection.ModelUnavailableError" },
        { models: [model({ supported: false })], model: requested, tag: "SessionSelection.ModelUnsupportedError" },
        {
          models: [model({ variants: ["high"] })],
          model: ModelV2.Ref.make({ ...requested, variant: ModelV2.VariantID.make("missing") }),
          tag: "SessionSelection.VariantNotFoundError",
        },
      ] as const

      for (const item of cases) {
        expect(
          yield* resolve({ model: item.model }).pipe(
            Effect.provide(layer({ models: [...item.models] })),
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
        ).toBe(item.tag)
      }
    }),
  )

  it.effect("preserves a validated explicit variant", () =>
    Effect.gen(function* () {
      const selected = yield* resolve({
        model: ModelV2.Ref.make({ providerID, id: modelID, variant: ModelV2.VariantID.make("high") }),
      }).pipe(Effect.provide(layer({ models: [model({ variants: ["high"] })] })))

      expect(selected.model.variant).toBe(ModelV2.VariantID.make("high"))
    }),
  )
})
