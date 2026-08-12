import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { OpenAIPlugin } from "@opencode-ai/core/plugin/provider/openai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  const integrations = yield* Integration.Service
  const events = yield* EventV2.Service
  yield* OpenAIPlugin.effect(host).pipe(
    Effect.provideService(Integration.Service, integrations),
    Effect.provideService(EventV2.Service, events),
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const clearOpenAICredentials = Effect.fn(function* () {
  const credentials = yield* Credential.Service
  for (const credential of yield* credentials.list(Integration.ID.make("openai"))) {
    yield* credentials.remove(credential.id)
  }
})

function eventually<A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, remaining = 1000): Effect.Effect<A> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value) || remaining === 0) return value
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

describe("OpenAIPlugin", () => {
  it.effect("registers browser and headless ChatGPT OAuth methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("openai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("chatgpt-browser"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (browser)",
        },
        {
          id: Integration.MethodID.make("chatgpt-headless"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (headless)",
        },
      ])
    }),
  )

  it.effect("creates an OpenAI SDK for @ai-sdk/openai using the provider ID as SDK name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai",
        options: { name: "custom-openai", apiKey: "test" },
      })
      expect(result.sdk?.responses("gpt-5").provider).toBe("custom-openai.responses")
    }),
  )

  it.effect("ignores non-OpenAI SDK packages", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "openai" },
      })
      expect(result.sdk).toBeUndefined()
    }),
  )

  it.effect("uses the Responses API for language models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("alias")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual(["responses:gpt-5"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("ignores non-OpenAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.anthropic, ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )

  it.effect("disables gpt-5-chat-latest during catalog transforms", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          api: { type: "aisdk", package: "@ai-sdk/openai" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5"))).enabled).toBe(true)
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5-chat-latest"))).enabled,
      ).toBe(false)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenAI providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.make("custom-openai")),
          api: { type: "aisdk", package: "test-provider" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5-chat-latest")))
          .enabled,
      ).toBe(true)
    }),
  )

  it.effect("projects the ChatGPT GPT-5.6 subscription limit into the V2 catalog", () =>
    Effect.gen(function* () {
      yield* clearOpenAICredentials()
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((draft) => {
        draft.provider.update(ProviderV2.ID.openai, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        draft.model.update(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5"), (model) => {
          model.limit = { context: 1_000_000, input: 872_000, output: 128_000 }
        })
        draft.model.update(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"), (model) => {
          model.limit = { context: 1_000_000, input: 872_000, output: 128_000 }
        })
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60 * 60 * 1000,
        }),
      })

      yield* addPlugin()

      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"))).limit).toEqual({
        context: 200_000,
        input: 72_000,
        output: 128_000,
      })
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5"))).limit).toEqual({
        context: 1_000_000,
        input: 872_000,
        output: 128_000,
      })
    }),
  )

  it.effect("reloads the V2 model policy when an OpenAI OAuth connection becomes active", () =>
    Effect.gen(function* () {
      yield* clearOpenAICredentials()
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      const events = yield* EventV2.Service
      yield* catalog.transform((draft) => {
        draft.provider.update(ProviderV2.ID.openai, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai" }
        })
        draft.model.update(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"), (model) => {
          model.limit = { context: 1_000_000, input: 872_000, output: 128_000 }
        })
      })
      yield* addPlugin()
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol"))).limit.context,
      ).toBe(1_000_000)

      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-headless"),
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60 * 60 * 1000,
        }),
      })
      yield* events.publish(Integration.Event.ConnectionUpdated, {
        integrationID: Integration.ID.make("openai"),
      })

      const model = required(
        yield* eventually(
          catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.6-sol")),
          (value) => value?.limit.context === 200_000,
        ),
      )
      expect(model.limit).toEqual({ context: 200_000, input: 72_000, output: 128_000 })
    }),
  )
})
