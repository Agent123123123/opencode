export * as SessionReset from "./reset"

import { and, desc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { SessionReset as Contract } from "@opencode-ai/schema/session-reset"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { Hash } from "../util/hash"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import type { SessionStore } from "./store"

type DatabaseService = Database.Interface["db"]
type ActiveTurn = {
  readonly turnID: SessionMessage.ID
  readonly turnStartedAt: DateTime.Utc
  readonly activityInputIDs: ReadonlyArray<SessionMessage.ID>
}

export { Contract }

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SessionReset.Conflict", {
  sessionID: SessionSchema.ID,
  reason: Schema.String,
}) {}

export const run = Effect.fn("SessionReset.run")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  store: SessionStore.Interface,
  sessionID: SessionSchema.ID,
  request: Contract.Request,
) {
  const eventID = deterministicEventID(request.resetID, "receipt")
  const existing = yield* findEvent(db, eventID)
  if (existing) return yield* decodeExisting(sessionID, request, existing)

  const session = yield* db
    .select({ managed: SessionTable.execution_managed, gateOpen: SessionTable.execution_gate_open })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!session?.managed) return yield* new Conflict({ sessionID, reason: "Session is not execution-managed" })
  if (session.gateOpen) return yield* new Conflict({ sessionID, reason: "Session execution gate is open" })
  if (yield* SessionInput.admittedAfter(db, sessionID, request.throughEventSeq)) {
    return yield* new Conflict({ sessionID, reason: "Session contains an Input after the reset cut" })
  }

  const plan = yield* loadPlan(db, sessionID, request).pipe(
    Effect.flatMap((existing) => existing ? Effect.succeed(existing) : createPlan(db, events, store, sessionID, request)),
  )

  const canceledInputIDs: SessionMessage.ID[] = []
  for (const inputID of plan.cancelInputIDs) {
    const canceled = yield* SessionInput.cancel(db, events, {
      id: inputID,
      sessionID,
      origin: request.reason === "runtime_shutdown" ? "runtime_shutdown" : "stale",
      reason: `Managed execution reset ${request.resetID}`,
      eventID: deterministicEventID(request.resetID, `cancel:${inputID}`),
      executionReset: resetReference(request),
    })
    if (canceled.outcome !== "canceled") {
      return yield* new Conflict({ sessionID, reason: `Input promoted during reset: ${inputID}` })
    }
    canceledInputIDs.push(inputID)
  }

  const notStarted: Contract.InputClosure[] = []
  for (const inputID of plan.notStartedInputIDs) {
    notStarted.push(yield* closeNotStarted(db, events, sessionID, request, inputID))
  }

  const tools: Contract.ToolClosure[] = []
  for (const tool of plan.tools) {
    tools.push(yield* closeTool(db, events, sessionID, request, plan.turn, tool))
  }

  const turn = plan.turn ? yield* closeActiveTurn(db, events, sessionID, request, plan.turn) : undefined
  if ((yield* activeTurn(db, sessionID)) !== undefined) {
    return yield* new Conflict({ sessionID, reason: "Session still has an active Turn after reset" })
  }
  const remaining = [
    ...(yield* SessionInput.unpromotedThrough(db, sessionID, request.throughEventSeq)),
    ...(yield* SessionInput.orphanedPromotedThrough(db, sessionID, request.throughEventSeq)),
  ]
  if (request.policy === "worker_flush" && remaining.length > 0) {
    return yield* new Conflict({ sessionID, reason: "Worker Session still has executable Input after reset" })
  }
  if (
    request.policy === "primary_preserve_user" &&
    remaining.some((input) => input.completion?.origin !== "builtin")
  ) {
    return yield* new Conflict({ sessionID, reason: "Primary Session still has framework Input after reset" })
  }

  const outcome = Contract.Outcome.make({
    schema: request.schema,
    sessionID,
    resetID: request.resetID,
    recoveryCellIncarnationID: request.recoveryCellIncarnationID,
    throughEventSeq: request.throughEventSeq,
    policy: request.policy,
    reason: request.reason,
    canceledInputIDs,
    notStarted,
    tools,
    ...(turn ? { turn } : {}),
    preservedInputIDs: plan.preservedInputIDs,
    idle: true,
  })
  const reset = yield* events.publish(SessionEvent.ExecutionReset, outcome, { id: eventID })
  if (!reset.durable) return yield* Effect.die("Execution reset event is not durable")
  return Contract.Receipt.make({ ...outcome, resetSeq: reset.durable.seq })
})

const createPlan = Effect.fn("SessionReset.createPlan")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  store: SessionStore.Interface,
  sessionID: SessionSchema.ID,
  request: Contract.Request,
) {
  const unpromoted = yield* SessionInput.unpromotedThrough(db, sessionID, request.throughEventSeq)
  const orphaned = yield* SessionInput.orphanedPromotedThrough(db, sessionID, request.throughEventSeq)
  const preserveIDs = new Set<SessionMessage.ID>()
  if (request.policy === "primary_preserve_user") {
    for (const input of [...unpromoted, ...orphaned]) {
      if (input.completion?.origin === "builtin" && (yield* resumeWasRequested(db, sessionID, input))) {
        preserveIDs.add(input.id)
      }
    }
  }
  const preserve = (input: SessionInput.Admitted) => preserveIDs.has(input.id)
  const active = yield* activeTurn(db, sessionID)
  const tools = (yield* store.context(sessionID)).flatMap((message) => {
    if (message.type !== "assistant") return []
    return message.content.flatMap((tool) =>
      tool.type === "tool" && (tool.state.status === "pending" || tool.state.status === "running")
        ? [Contract.ToolTarget.make({
            assistantMessageID: message.id,
            callID: tool.id,
            outcome: tool.state.status === "running" ? "outcome_unknown" : "interrupted",
            providerExecuted: tool.provider?.executed === true,
          })]
        : []
    )
  })
  const plan = Contract.Plan.make({
    schema: request.schema,
    sessionID,
    resetID: request.resetID,
    recoveryCellIncarnationID: request.recoveryCellIncarnationID,
    throughEventSeq: request.throughEventSeq,
    policy: request.policy,
    reason: request.reason,
    cancelInputIDs: unpromoted.filter((input) => !preserve(input)).map((input) => input.id),
    notStartedInputIDs: orphaned.filter((input) => !preserve(input)).map((input) => input.id),
    tools,
    ...(active
      ? {
          turn: Contract.TurnTarget.make({
            ...active,
            outcome: tools.some((tool) => tool.outcome === "outcome_unknown")
              ? "outcome_unknown"
              : "interrupted",
          }),
        }
      : {}),
    preservedInputIDs: [...unpromoted, ...orphaned]
      .filter(preserve)
      .toSorted((left, right) => left.admittedSeq - right.admittedSeq)
      .map((input) => input.id),
  })
  const event = yield* events.publish(SessionEvent.ExecutionResetStarted, plan, {
    id: deterministicEventID(request.resetID, "plan"),
  })
  if (!event.durable) return yield* Effect.die("Execution reset plan event is not durable")
  return plan
})

const resumeWasRequested = Effect.fn("SessionReset.resumeWasRequested")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  input: SessionInput.Admitted,
) {
  const row = yield* db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.seq, input.admittedSeq)))
    .get()
    .pipe(Effect.orDie)
  const expected = EventV2.versionedType(
    SessionEvent.PromptAdmitted.type,
    SessionEvent.PromptAdmitted.durable!.version,
  )
  if (!row || row.type !== expected) return false
  const admission = Schema.decodeUnknownSync(SessionEvent.PromptAdmitted.data)(row.data)
  return admission.messageID === input.id && admission.resumeRequested !== false
})

const loadPlan = Effect.fn("SessionReset.loadPlan")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  request: Contract.Request,
) {
  const row = yield* findEvent(db, deterministicEventID(request.resetID, "plan"))
  if (!row) return
  const expectedType = EventV2.versionedType(
    SessionEvent.ExecutionResetStarted.type,
    SessionEvent.ExecutionResetStarted.durable!.version,
  )
  if (row.aggregate_id !== sessionID || row.type !== expectedType) {
    return yield* new Conflict({ sessionID, reason: `Reset plan identity collision: ${request.resetID}` })
  }
  const plan = Schema.decodeUnknownSync(Contract.Plan)(row.data)
  if (
    plan.resetID !== request.resetID ||
    plan.recoveryCellIncarnationID !== request.recoveryCellIncarnationID ||
    plan.throughEventSeq !== request.throughEventSeq ||
    plan.policy !== request.policy || plan.reason !== request.reason
  ) return yield* new Conflict({ sessionID, reason: `Reset request conflicts with plan: ${request.resetID}` })
  return plan
})

const closeNotStarted = Effect.fn("SessionReset.closeNotStarted")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  request: Contract.Request,
  inputID: SessionMessage.ID,
) {
  const eventID = deterministicEventID(request.resetID, `not_started:${inputID}`)
  const existing = yield* terminalSequence(
    db,
    sessionID,
    eventID,
    SessionEvent.Turn.NotStarted.type,
    SessionEvent.Turn.NotStarted.durable!.version,
  )
  const turnID = deterministicMessageID(request.resetID, `not_started:${inputID}`)
  if (existing !== undefined) return Contract.InputClosure.make({ inputID, turnID, eventSeq: existing })
  const input = yield* SessionInput.find(db, inputID)
  const event = yield* events.publish(SessionEvent.Turn.NotStarted, {
    sessionID,
    timestamp: yield* DateTime.now,
    schema: "opencode.turn_not_started.v2",
    turnID,
    activityInputIDs: [inputID],
    outcome: "interrupted",
    reason: `Managed execution reset ${request.resetID}`,
    errorClass: "interrupt",
    managedExecution: input?.completion?.managedExecution,
    executionReset: resetReference(request),
  }, { id: eventID })
  if (!event.durable) return yield* Effect.die("Reset NotStarted event is not durable")
  return Contract.InputClosure.make({ inputID, turnID, eventSeq: event.durable.seq })
})

const closeTool = Effect.fn("SessionReset.closeTool")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  request: Contract.Request,
  turn: Contract.TurnTarget | undefined,
  tool: Contract.ToolTarget,
) {
  const eventID = deterministicEventID(request.resetID, `tool:${tool.assistantMessageID}:${tool.callID}`)
  const existing = yield* terminalSequence(
    db,
    sessionID,
    eventID,
    SessionEvent.Tool.Failed.type,
    SessionEvent.Tool.Failed.durable!.version,
  )
  if (existing !== undefined) return Contract.ToolClosure.make({ ...tool, eventSeq: existing })
  const event = yield* events.publish(SessionEvent.Tool.Failed, {
    sessionID,
    timestamp: yield* DateTime.now,
    assistantMessageID: tool.assistantMessageID,
    callID: tool.callID,
    ...(turn ? { turnID: turn.turnID, activityInputIDs: turn.activityInputIDs } : {}),
    error: {
      type: "unknown",
      message: tool.outcome === "outcome_unknown"
        ? "Tool outcome unknown after managed process loss"
        : "Tool execution interrupted by managed reset",
    },
    provider: { executed: tool.providerExecuted },
    managedExecution: turn?.managedExecution,
  }, { id: eventID })
  if (!event.durable) return yield* Effect.die("Reset Tool.Failed event is not durable")
  return Contract.ToolClosure.make({
    assistantMessageID: tool.assistantMessageID,
    callID: tool.callID,
    outcome: tool.outcome,
    eventSeq: event.durable.seq,
  })
})

const activeTurn = Effect.fn("SessionReset.activeTurn")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ turnID: SessionTable.active_turn_id, inputIDs: SessionTable.active_input_ids })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row?.turnID) return
  const startedType = EventV2.versionedType(
    SessionEvent.Turn.Started.type,
    SessionEvent.Turn.Started.durable!.version,
  )
  const decoder = Schema.decodeUnknownSync(SessionEvent.Turn.Started.data)
  const candidates = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, startedType)))
    .orderBy(desc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const started = candidates.map((candidate) => decoder(candidate.data)).find((event) => event.turnID === row.turnID)
  if (!started) return yield* new Conflict({ sessionID, reason: `Active Turn has no Started proof: ${row.turnID}` })
  return {
    turnID: SessionMessage.ID.make(row.turnID),
    turnStartedAt: started.turnStartedAt,
    activityInputIDs: row.inputIDs ?? started.activityInputIDs,
    managedExecution: started.managedExecution,
  }
})

const closeActiveTurn = Effect.fn("SessionReset.closeActiveTurn")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  request: Contract.Request,
  active: Contract.TurnTarget,
) {
  const eventID = deterministicEventID(request.resetID, `turn:${active.turnID}`)
  const existing = yield* terminalSequence(
    db,
    sessionID,
    eventID,
    SessionEvent.Turn.Settled.type,
    SessionEvent.Turn.Settled.durable!.version,
  )
  if (existing !== undefined) {
    return Contract.TurnClosure.make({ turnID: active.turnID, outcome: active.outcome, eventSeq: existing })
  }
  const unknown = active.outcome === "outcome_unknown"
  const event = yield* events.publish(SessionEvent.Turn.Settled, {
    sessionID,
    timestamp: yield* DateTime.now,
    schema: "opencode.turn_settled.v3",
    turnID: active.turnID,
    turnStartedAt: active.turnStartedAt,
    activityInputIDs: active.activityInputIDs,
    outcome: unknown ? "error" : "aborted",
    reason: unknown
      ? "Effectful tool outcome unknown after managed process loss"
      : `Managed execution reset ${request.resetID}`,
    errorClass: unknown ? "tool_unknown" : "interrupt",
    managedExecution: active.managedExecution,
    executionReset: resetReference(request),
    ...(unknown
      ? {
          failure: {
            kind: "tool_effect_unknown" as const,
            safeMessage: "A tool started but no terminal outcome was recorded before process loss",
            retryable: false,
            retryExhausted: true,
            attemptCount: 1,
          },
        }
      : { abortOrigin: request.reason === "runtime_shutdown" ? "runtime_shutdown" as const : "unknown" as const }),
  }, { id: eventID })
  if (!event.durable) return yield* Effect.die("Reset Turn.Settled event is not durable")
  return Contract.TurnClosure.make({
    turnID: active.turnID,
    outcome: unknown ? "outcome_unknown" : "interrupted",
    eventSeq: event.durable.seq,
  })
})

const terminalSequence = Effect.fn("SessionReset.terminalSequence")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  eventID: EventV2.ID,
  type: string,
  version: number,
) {
  const row = yield* findEvent(db, eventID)
  if (!row) return
  if (row.aggregate_id !== sessionID || row.type !== EventV2.versionedType(type, version)) {
    return yield* new Conflict({ sessionID, reason: `Reset terminal event identity collision: ${eventID}` })
  }
  return row.seq
})

const findEvent = Effect.fn("SessionReset.findEvent")(function* (
  db: DatabaseService,
  eventID: EventV2.ID,
) {
  return yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.id, eventID))
    .get()
    .pipe(Effect.orDie)
})

const decodeExisting = Effect.fn("SessionReset.decodeExisting")(function* (
  sessionID: SessionSchema.ID,
  request: Contract.Request,
  row: typeof EventTable.$inferSelect,
) {
  const expectedType = EventV2.versionedType(
    SessionEvent.ExecutionReset.type,
    SessionEvent.ExecutionReset.durable!.version,
  )
  if (row.aggregate_id !== sessionID || row.type !== expectedType) {
    return yield* new Conflict({ sessionID, reason: `Reset event identity collision: ${request.resetID}` })
  }
  const outcome = Schema.decodeUnknownSync(Contract.Outcome)(row.data)
  if (
    outcome.resetID !== request.resetID ||
    outcome.recoveryCellIncarnationID !== request.recoveryCellIncarnationID ||
    outcome.throughEventSeq !== request.throughEventSeq ||
    outcome.policy !== request.policy || outcome.reason !== request.reason
  ) return yield* new Conflict({ sessionID, reason: `Reset request conflicts with receipt: ${request.resetID}` })
  return Contract.Receipt.make({ ...outcome, resetSeq: row.seq })
})

function deterministicEventID(resetID: Contract.ID, suffix: string) {
  return EventV2.ID.make(`evt_reset_${Hash.sha256(`${resetID}\0${suffix}`).slice(0, 48)}`)
}

function deterministicMessageID(resetID: Contract.ID, suffix: string) {
  return SessionMessage.ID.make(`msg_reset_${Hash.sha256(`${resetID}\0${suffix}`).slice(0, 48)}`)
}

function resetReference(request: Contract.Request): Contract.Reference {
  return Contract.Reference.make({
    resetID: request.resetID,
    recoveryCellIncarnationID: request.recoveryCellIncarnationID,
    reason: request.reason,
  })
}
