import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Context, Effect, Schema } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const context = Context.empty() as Context.Context<unknown>

function catalogConfig() {
  const url = "http://127.0.0.1:1"
  const config = testProviderConfig(url)
  return {
    ...config,
    agent: {
      "hidden-worker": {
        mode: "primary" as const,
        hidden: true,
        model: "test/test-model",
      },
    },
    provider: {
      ...config.provider,
      test: {
        ...config.provider.test,
        // V2 Catalog availability intentionally checks provider request facts, not SDK-only
        // settings. No model request is made in these tests.
        options: { baseURL: url, body: { apiKey: "test-key" } },
      },
    },
  }
}

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("validates session create through the location catalog and returns exact readback", async () => {
    await using tmp = await tmpdir({ git: true, config: catalogConfig() })
    const id = "ses_catalog_validated"
    const payload = {
      id,
      agent: "build",
      model: { providerID: "test", id: "test-model", variant: "default" },
      location: { directory: tmp.path },
    }
    const create = () =>
      request("/api/session", tmp.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })

    const first = await create()
    const firstBody = await first.json()
    expect({ status: first.status, body: firstBody }).toMatchObject({ status: 200, body: { data: payload } })

    const retried = await create()
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ data: payload })

    const readback = await request(`/api/session/${id}`, tmp.path)
    expect(readback.status).toBe(200)
    expect(await readback.json()).toMatchObject({ data: payload })

    const hidden = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        id: "ses_hidden_primary",
        agent: "hidden-worker",
      }),
    })
    expect({ status: hidden.status, body: await hidden.json() }).toMatchObject({
      status: 200,
      body: { data: { id: "ses_hidden_primary", agent: "hidden-worker" } },
    })
  })

  test("keeps standard plugin tools attached to the V2 session location", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir({ git: true })),
          (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
        )
        const configDirectory = path.join(tmp.path, ".opencode")
        yield* Effect.promise(() => markPluginDependenciesReady(configDirectory))
        yield* Effect.promise(() => markPluginDependenciesReady(Global.Path.config))
        const plugin = path.join(tmp.path, "standard-plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            plugin,
            [
              "export default async () => ({",
              "  tool: {",
              "    bridge_probe: {",
              '      description: "Bridge probe",',
              "      args: {},",
              '      execute: async () => "bridged",',
              "    },",
              "  },",
              "})",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(tmp.path, "opencode.json"),
            JSON.stringify({
              ...testProviderConfig(llm.url),
              provider: {
                test: {
                  ...testProviderConfig(llm.url).provider.test,
                  options: { apiKey: "test-key", baseURL: llm.url, body: { apiKey: "test-key" } },
                },
              },
              plugin: [pathToFileURL(plugin).href],
            }),
          ),
        )

        const payload = {
          id: "ses_standard_plugin_bridge",
          title: "Standard plugin bridge",
          agent: "build",
          model: { providerID: "test", id: "test-model", variant: "default" },
          location: { directory: tmp.path },
        }
        const created = yield* Effect.promise(() =>
          request("/api/session", tmp.path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        )
        expect({ status: created.status, body: yield* Effect.promise(() => created.json()) }).toMatchObject({
          status: 200,
        })

        const initialized = yield* Effect.promise(() => request("/agent", tmp.path)).pipe(
          Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.fail(new Error("agent init timed out")) }),
        )
        expect({ status: initialized.status, body: yield* Effect.promise(() => initialized.json()) }).toMatchObject({
          status: 200,
        })
        yield* llm.text("done")
        const prompted = yield* Effect.promise(() =>
          request(`/api/session/${payload.id}/prompt`, tmp.path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: { text: "Use the bridge probe." }, delivery: "queue" }),
          }),
        ).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new Error("prompt timed out")) }),
        )
        expect(prompted.status).toBe(200)
        yield* llm.wait(1).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new Error("LLM call timed out")) }),
        )
        expect(JSON.stringify((yield* llm.inputs)[0])).toContain('"name":"bridge_probe"')
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
    )
  }, 60_000)

  test("rejects invalid selections and conflicting session identities", async () => {
    await using tmp = await tmpdir({ git: true, config: catalogConfig() })
    await using other = await tmpdir({ git: true })
    const id = "ses_catalog_conflict"
    const base = {
      id,
      agent: "build",
      model: { providerID: "test", id: "test-model", variant: "default" },
      location: { directory: tmp.path },
    }
    const post = (payload: unknown, directory = tmp.path) =>
      request("/api/session", directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })

    expect((await post({ ...base, id: "ses_unknown_agent", agent: "missing" })).status).toBe(400)
    expect(
      (
        await post({
          ...base,
          id: "ses_unknown_model",
          model: { providerID: "test", id: "missing", variant: "default" },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await post({
          ...base,
          id: "ses_unknown_variant",
          model: { providerID: "test", id: "test-model", variant: "missing" },
        })
      ).status,
    ).toBe(400)

    const created = await post(base)
    expect({ status: created.status, body: await created.json() }).toMatchObject({ status: 200 })
    expect((await post({ ...base, agent: "plan" })).status).toBe(409)
    expect((await post({ ...base, location: { directory: other.path } }, other.path)).status).toBe(409)
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/session", publisher.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
