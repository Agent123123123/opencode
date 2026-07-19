import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Integration } from "@opencode-ai/core/integration"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(LayerNode.compile(Credential.node))

describe("Credential", () => {
  test("imports supported standard auth.json credentials once", async () => {
    await using tmp = await tmpdir()
    await Bun.write(
      path.join(tmp.path, "auth.json"),
      JSON.stringify({
        openai: { type: "oauth", refresh: "refresh", access: "access", expires: 123 },
        "zai-coding-plan": { type: "api", key: "zai-key" },
      }),
    )
    const database = Database.layerFromPath(path.join(tmp.path, "credential.db"))
    const runtime = () =>
      AppNodeBuilder.build(Credential.node, [
        [Database.node, database],
        [Global.node, Global.layerWith({ data: tmp.path })],
      ])
    const imported = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Credential.Service).all()
      }).pipe(Effect.provide(runtime()), Effect.scoped),
    )

    expect(imported.map((item) => item.integrationID).sort()).toEqual([
      Integration.ID.make("openai"),
      Integration.ID.make("zai-coding-plan"),
    ])
    expect(imported.find((item) => item.integrationID === "zai-coding-plan")?.value).toMatchObject({
      type: "key",
      key: "zai-key",
    })

    await Bun.write(
      path.join(tmp.path, "auth.json"),
      JSON.stringify({ openai: { type: "api", key: "replacement" } }),
    )
    const unchanged = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Credential.Service).list(Integration.ID.make("openai"))
      }).pipe(Effect.provide(runtime()), Effect.scoped),
    )
    expect(unchanged[0]?.value).toMatchObject({ type: "oauth", access: "access" })
  })

  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
})
