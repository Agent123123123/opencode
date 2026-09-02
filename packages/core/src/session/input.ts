export * as SessionInput from "./input"

import { and, asc, eq, isNotNull, isNull, lte, notExists } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import {
  Admitted,
  CancelOrigin,
  CancelResult,
  Completion,
  CompletionContract,
  CompletionContractDigest,
  CompletionContractOrigin,
  Delivery,
  OrdinaryStopCompletionContract,
  RequiredTerminalToolCompletionContract,
  Status,
} from "@opencode-ai/schema/session-input"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputCancellationTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { Hash } from "../util/hash"

type DatabaseService = Database.Interface["db"]

export {
  Admitted,
  CancelOrigin,
  CancelResult,
  Completion,
  CompletionContract,
  CompletionContractDigest,
  CompletionContractOrigin,
  Delivery,
  OrdinaryStopCompletionContract,
  RequiredTerminalToolCompletionContract,
  Status,
}

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const decodeCompletion = Schema.decodeUnknownSync(Completion)
const encodeCompletion = Schema.encodeSync(Completion)
const encodeCompletionContract = Schema.encodeSync(CompletionContract)

export const makeCompletion = (
  origin: CompletionContractOrigin,
  contract: CompletionContract,
): Completion => {
  const canonical = contract.mode === "ordinary_stop"
    ? OrdinaryStopCompletionContract.make(contract)
    : RequiredTerminalToolCompletionContract.make({
        ...contract,
        terminalTools: [...new Set(contract.terminalTools)].sort(),
      })
  return Completion.make({
    origin,
    contract: canonical,
    digest: CompletionContractDigest.make(Hash.sha256(JSON.stringify(encodeCompletionContract(canonical)))),
  })
}

export const ordinaryCompletion = () =>
  makeCompletion("builtin", OrdinaryStopCompletionContract.make({
    schema: "opencode.managed_completion.v1",
    mode: "ordinary_stop",
  }))

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    ...(row.completion === null ? {} : { completion: decodeCompletion(row.completion) }),
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

const findCancellation = Effect.fn("SessionInput.findCancellation")(function* (
  db: DatabaseService,
  id: SessionMessage.ID,
) {
  return yield* db
    .select()
    .from(SessionInputCancellationTable)
    .where(eq(SessionInputCancellationTable.id, id))
    .get()
    .pipe(Effect.orDie)
})

const uncanceled = (db: DatabaseService) =>
  notExists(
    db
      .select({ id: SessionInputCancellationTable.id })
      .from(SessionInputCancellationTable)
      .where(eq(SessionInputCancellationTable.id, SessionInputTable.id)),
  )

const executionAllowed = (db: DatabaseService) =>
  notExists(
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(and(
        eq(SessionTable.id, SessionInputTable.session_id),
        eq(SessionTable.execution_managed, true),
        eq(SessionTable.execution_gate_open, false),
      )),
  )

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const query = Effect.fn("SessionInput.query")(function* (
  db: DatabaseService,
  input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID },
) {
  const canceled = yield* findCancellation(db, input.id)
  if (canceled) {
    if (canceled.session_id !== input.sessionID) return Status.make({ state: "missing" })
    return Status.make({
      state: "canceled",
      id: input.id,
      sessionID: input.sessionID,
      cancelSeq: canceled.cancel_seq,
      origin: canceled.origin,
      reason: canceled.reason,
      timeCanceled: DateTime.makeUnsafe(canceled.time_canceled),
      inputVisibility: canceled.input_visibility,
    })
  }
  const admitted = yield* find(db, input.id)
  if (!admitted || admitted.sessionID !== input.sessionID) return Status.make({ state: "missing" })
  return Status.make({
    state: admitted.promotedSeq === undefined ? "admitted" : "promoted",
    input: admitted,
  })
})

export const cancel = Effect.fn("SessionInput.cancel")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly origin: CancelOrigin
    readonly reason: string
  },
) {
  const current = yield* query(db, input)
  if (current.state === "canceled") {
    if (current.origin !== input.origin || current.reason !== input.reason) {
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    }
    return CancelResult.make({ outcome: "canceled", status: current })
  }
  if (current.state === "promoted") return CancelResult.make({ outcome: "too_late", status: current })
  const timestamp = yield* DateTime.now
  yield* events
    .publish(SessionEvent.PromptCanceled, {
      sessionID: input.sessionID,
      messageID: input.id,
      timestamp,
      origin: input.origin,
      reason: input.reason,
      inputVisibility: current.state === "admitted" ? "admitted_unpromoted" : "missing",
    })
    .pipe(
      Effect.catchDefect((defect) =>
        query(db, input).pipe(
          Effect.flatMap((stored) =>
            stored.state === "canceled" && stored.origin === input.origin && stored.reason === input.reason
              ? Effect.void
              : Effect.die(defect),
          ),
        ),
      ),
    )
  const canceled = yield* query(db, input)
  if (canceled.state !== "canceled") return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return CancelResult.make({ outcome: "canceled", status: canceled })
})

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly completion?: Completion
  },
) {
  if (yield* findCancellation(db, input.id)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptAdmitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
      completion: input.completion,
    })
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              Admitted.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                completion: input.completion,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly completion?: Completion
    readonly timeCreated: DateTime.Utc
  },
) {
  if (yield* findCancellation(db, input.id)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      completion: input.completion ?? null,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectCanceled = Effect.fn("SessionInput.projectCanceled")(function* (
  db: DatabaseService,
  input: {
    readonly cancelSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly origin: CancelOrigin
    readonly reason: string
    readonly inputVisibility: "missing" | "admitted_unpromoted"
    readonly timeCanceled: DateTime.Utc
  },
) {
  const admitted = yield* find(db, input.id)
  if (admitted?.promotedSeq !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  if (admitted && admitted.sessionID !== input.sessionID) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputCancellationTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      cancel_seq: input.cancelSeq,
      origin: input.origin,
      reason: input.reason,
      input_visibility: input.inputVisibility,
      time_canceled: DateTime.toEpochMillis(input.timeCanceled),
    })
    .onConflictDoNothing()
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (stored) return
  const existing = yield* findCancellation(db, input.id)
  if (
    !existing || existing.session_id !== input.sessionID || existing.cancel_seq !== input.cancelSeq ||
    existing.origin !== input.origin || existing.reason !== input.reason ||
    existing.input_visibility !== input.inputVisibility ||
    existing.time_canceled !== DateTime.toEpochMillis(input.timeCanceled)
  ) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly completion?: Completion
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  // A steer promoted after Turn.Started belongs to that same physical turn.
  // Persist the association at the promotion boundary so a concurrent wake or
  // restart cannot mistake a live continuation input for an orphaned promotion.
  const active = yield* db
    .select({ turnID: SessionTable.active_turn_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  const updated = yield* db
    .update(SessionInputTable)
    .set({
      promoted_seq: input.promotedSeq,
      ...(active?.turnID ? { turn_id: active.turnID } : {}),
    })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        uncanceled(db),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (yield* findCancellation(db, input.id)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      completion: input.completion ?? null,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      turn_id: active?.turnID ?? null,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, delivery),
        uncanceled(db),
        executionAllowed(db),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

/** Sessions whose durable inbox still contains work that has not been claimed by a runner. */
export const pendingSessionIDs = Effect.fn("SessionInput.pendingSessionIDs")(function* (db: DatabaseService) {
  const rows = yield* db
    .selectDistinct({ sessionID: SessionInputTable.session_id })
    .from(SessionInputTable)
    .where(and(isNull(SessionInputTable.promoted_seq), uncanceled(db), executionAllowed(db)))
    .orderBy(asc(SessionInputTable.session_id))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => SessionSchema.ID.make(row.sessionID))
})

/** Promoted input whose owning process died before durable Turn.Started. */
export const hasOrphanedPromoted = Effect.fn("SessionInput.hasOrphanedPromoted")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(and(
      eq(SessionInputTable.session_id, sessionID),
      isNotNull(SessionInputTable.promoted_seq),
      isNull(SessionInputTable.turn_id),
      executionAllowed(db),
    ))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const orphanedPromotedSessionIDs = Effect.fn("SessionInput.orphanedPromotedSessionIDs")(function* (
  db: DatabaseService,
) {
  const rows = yield* db
    .selectDistinct({ sessionID: SessionInputTable.session_id })
    .from(SessionInputTable)
    .where(and(
      isNotNull(SessionInputTable.promoted_seq),
      isNull(SessionInputTable.turn_id),
      executionAllowed(db),
    ))
    .orderBy(asc(SessionInputTable.session_id))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => SessionSchema.ID.make(row.sessionID))
})

/** Read the exact pending inputs that the next promotion will publish, without mutating inbox state. */
export const pendingActivityIDs = Effect.fn("SessionInput.pendingActivityIDs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
  cutoff: number,
) {
  const pending = and(
    eq(SessionInputTable.session_id, sessionID),
    isNull(SessionInputTable.promoted_seq),
    uncanceled(db),
    executionAllowed(db),
  )
  if (delivery === "steer") {
    return (yield* db
      .select({ id: SessionInputTable.id })
      .from(SessionInputTable)
      .where(and(pending, eq(SessionInputTable.delivery, "steer"), lte(SessionInputTable.admitted_seq, cutoff)))
      .orderBy(asc(SessionInputTable.admitted_seq))
      .all()
      .pipe(Effect.orDie)).map((row) => SessionMessage.ID.make(row.id))
  }
  const queued = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(and(pending, eq(SessionInputTable.delivery, "queue")))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const steers = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(and(pending, eq(SessionInputTable.delivery, "steer"), lte(SessionInputTable.admitted_seq, cutoff)))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return [
    ...(queued ? [SessionMessage.ID.make(queued.id)] : []),
    ...steers.map((row) => SessionMessage.ID.make(row.id)),
  ]
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly completion?: Completion
  },
) =>
  input.delivery === expected.delivery && matchesPrompt(input, expected) &&
  JSON.stringify(input.completion ? encodeCompletion(input.completion) : null) ===
    JSON.stringify(expected.completion ? encodeCompletion(expected.completion) : null)

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly completion?: Completion
    readonly timeCreated: DateTime.Utc
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    const id = SessionMessage.ID.make(row.id)
    yield* events
      .publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(row.time_created),
        messageID: id,
        prompt: decodePrompt(row.prompt),
        delivery: row.delivery,
        completion: row.completion === null ? undefined : decodeCompletion(row.completion),
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, id).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows.length
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
        uncanceled(db),
        executionAllowed(db),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        eq(SessionInputTable.delivery, "queue"),
        uncanceled(db),
        executionAllowed(db),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row]).pipe(Effect.as(true))
})
