export * as Credential from "./credential"

import path from "path"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { DataMigrationTable } from "./data-migration.sql"
import { FSUtil } from "./fs-util"
import { Global } from "./global"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

const LegacyOAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.String.pipe(Schema.optional),
  enterpriseUrl: Schema.String.pipe(Schema.optional),
})

const LegacyKey = Schema.Struct({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
})

const LegacyValue = Schema.Union([LegacyOAuth, LegacyKey])

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* Effect.gen(function* () {
      const migration = "credential.auth-json"
      const completed = yield* db
        .select()
        .from(DataMigrationTable)
        .where(eq(DataMigrationTable.name, migration))
        .get()
      if (completed) return
      const raw = yield* fs.readJson(path.join(global.data, "auth.json")).pipe(Effect.option)
      if (Option.isNone(raw) || typeof raw.value !== "object" || raw.value === null || Array.isArray(raw.value)) return
      const decode = Schema.decodeUnknownOption(LegacyValue)
      const values = Object.entries(raw.value).flatMap(([integrationID, value]) => {
        const decoded = decode(value)
        if (Option.isNone(decoded)) return []
        const legacy = decoded.value
        const credential: Value =
          legacy.type === "api"
            ? Key.make({ type: "key", key: legacy.key, metadata: legacy.metadata })
            : OAuth.make({
                type: "oauth",
                methodID: Integration.MethodID.make(integrationID === "openai" ? "chatgpt-browser" : "oauth"),
                refresh: legacy.refresh,
                access: legacy.access,
                expires: legacy.expires,
                metadata: {
                  ...(legacy.accountId ? { accountID: legacy.accountId } : {}),
                  ...(legacy.enterpriseUrl ? { enterpriseURL: legacy.enterpriseUrl } : {}),
                },
              })
        return [{ integrationID: Integration.ID.make(integrationID.replace(/\/+$/, "")), value: credential }]
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (const item of values) {
            const existing = yield* tx
              .select({ id: CredentialTable.id })
              .from(CredentialTable)
              .where(eq(CredentialTable.integration_id, item.integrationID))
              .get()
            if (existing) continue
            yield* tx.insert(CredentialTable).values({
              id: ID.create(),
              integration_id: item.integrationID,
              label: "Imported",
              value: item.value,
            })
          }
          yield* tx
            .insert(DataMigrationTable)
            .values({ name: migration, time_completed: Date.now() })
            .onConflictDoNothing()
            .run()
        }),
      )
    }).pipe(Effect.orDie)
    const decode = Schema.decodeUnknownSync(Value)
    const stored = (row: typeof CredentialTable.$inferSelect) => {
      if (!row.integration_id) return
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value: decode(row.value),
      })
    }

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        return (yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        return (yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)).flatMap((row) => {
          const credential = stored(row)
          return credential ? [credential] : []
        })
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: credential.value,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value: updates.value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, FSUtil.node, Global.node] })
