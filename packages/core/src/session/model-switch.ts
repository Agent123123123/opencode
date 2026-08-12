export * as SessionModelSwitch from "./model-switch"

import { and, desc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

const requestedType = Event.versionedType(
  SessionEvent.ModelSwitchRequested.type,
  SessionEvent.ModelSwitchRequested.durable!.version,
)
const appliedType = Event.versionedType(SessionEvent.ModelSwitched.type, SessionEvent.ModelSwitched.durable!.version)
const decodeRequest = Schema.decodeUnknownSync(SessionEvent.ModelSwitchRequested.data)
const decodeApplied = Schema.decodeUnknownSync(SessionEvent.ModelSwitched.data)

const sameModel = (
  left: (typeof SessionEvent.ModelSwitchRequested.Type)["data"]["model"],
  right: (typeof SessionEvent.ModelSwitchRequested.Type)["data"]["model"],
) =>
  left.id === right.id &&
  left.providerID === right.providerID &&
  (left.variant ?? "default") === (right.variant ?? "default")

export type Pending = {
  readonly eventID: EventV2.ID
  readonly seq: number
  readonly model: (typeof SessionEvent.ModelSwitchRequested.Type)["data"]["model"]
}

/** Latest desired selection when it has not yet crossed a Session boundary. */
export const pending = Effect.fn("SessionModelSwitch.pending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const requestRow = yield* db
    .select()
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, requestedType)))
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!requestRow) return
  const request = decodeRequest(requestRow.data)
  const appliedRow = yield* db
    .select()
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, appliedType)))
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (appliedRow && appliedRow.seq > requestRow.seq && sameModel(decodeApplied(appliedRow.data).model, request.model))
    return
  return {
    eventID: requestRow.id,
    seq: requestRow.seq,
    model: request.model,
  } satisfies Pending
})

/** Sessions whose durable desired model still needs to be applied after restart. */
export const pendingSessionIDs = Effect.fn("SessionModelSwitch.pendingSessionIDs")(function* (db: DatabaseService) {
  const rows = yield* db
    .select({ sessionID: EventTable.aggregate_id })
    .from(EventTable)
    .where(eq(EventTable.type, requestedType))
    .all()
    .pipe(Effect.orDie)
  const sessionIDs = [...new Set(rows.map((row) => row.sessionID))].map((sessionID) => SessionSchema.ID.make(sessionID))
  const states = yield* Effect.forEach(sessionIDs, (sessionID) =>
    pending(db, sessionID).pipe(Effect.map((request) => (request ? sessionID : undefined))),
  )
  return states.filter((sessionID): sessionID is SessionSchema.ID => sessionID !== undefined)
})

/** Apply exactly one latest durable request. Superseded requests need no event. */
export const applyPending = Effect.fn("SessionModelSwitch.applyPending")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const request = yield* pending(db, sessionID)
  if (!request) return false
  yield* events.publish(SessionEvent.ModelSwitched, {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    model: request.model,
  })
  return true
})
