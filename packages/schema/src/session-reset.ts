export * as SessionReset from "./session-reset"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"
import { ManagedExecutionRef } from "./session-input"

export const ID = Schema.String.check(Schema.isStartsWith("rst_")).pipe(
  Schema.brand("SessionReset.ID"),
)
export type ID = typeof ID.Type

export const Policy = Schema.Literals(["worker_flush", "primary_preserve_user"])
export type Policy = typeof Policy.Type

export const Reason = Schema.Literals(["runtime_shutdown", "process_lost"])
export type Reason = typeof Reason.Type

/**
 * Identifies a terminal fact written by the Host as part of a managed reset.
 * Consumers use this proof to distinguish recovery closure from an ordinary
 * user/framework cancellation of the same Turn or Input.
 */
export const Reference = Schema.Struct({
  resetID: ID,
  recoveryCellIncarnationID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  reason: Reason,
}).annotate({ identifier: "SessionReset.Reference" })
export interface Reference extends Schema.Schema.Type<typeof Reference> {}

export const EventCursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)).annotate({
  identifier: "SessionReset.EventCursor",
})
export type EventCursor = typeof EventCursor.Type

export const Request = Schema.Struct({
  schema: Schema.Literal("opencode.managed_execution_reset.v1"),
  resetID: ID,
  recoveryCellIncarnationID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  throughEventSeq: EventCursor,
  policy: Policy,
  reason: Reason,
}).annotate({ identifier: "SessionReset.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const InputClosure = Schema.Struct({
  inputID: SessionMessage.ID,
  turnID: SessionMessage.ID,
  eventSeq: NonNegativeInt,
}).annotate({ identifier: "SessionReset.InputClosure" })
export interface InputClosure extends Schema.Schema.Type<typeof InputClosure> {}

export const ToolClosure = Schema.Struct({
  assistantMessageID: SessionMessage.ID,
  callID: Schema.String,
  outcome: Schema.Literals(["interrupted", "outcome_unknown"]),
  eventSeq: NonNegativeInt,
}).annotate({ identifier: "SessionReset.ToolClosure" })
export interface ToolClosure extends Schema.Schema.Type<typeof ToolClosure> {}

export const ToolTarget = Schema.Struct({
  assistantMessageID: SessionMessage.ID,
  callID: Schema.String,
  outcome: ToolClosure.fields.outcome,
  providerExecuted: Schema.Boolean,
}).annotate({ identifier: "SessionReset.ToolTarget" })
export interface ToolTarget extends Schema.Schema.Type<typeof ToolTarget> {}

export const TurnClosure = Schema.Struct({
  turnID: SessionMessage.ID,
  outcome: Schema.Literals(["interrupted", "outcome_unknown"]),
  eventSeq: NonNegativeInt,
}).annotate({ identifier: "SessionReset.TurnClosure" })
export interface TurnClosure extends Schema.Schema.Type<typeof TurnClosure> {}

export const TurnTarget = Schema.Struct({
  turnID: SessionMessage.ID,
  turnStartedAt: DateTimeUtcFromMillis,
  activityInputIDs: Schema.Array(SessionMessage.ID),
  outcome: TurnClosure.fields.outcome,
  managedExecution: ManagedExecutionRef.pipe(optional),
}).annotate({ identifier: "SessionReset.TurnTarget" })
export interface TurnTarget extends Schema.Schema.Type<typeof TurnTarget> {}

export const Plan = Schema.Struct({
  schema: Request.fields.schema,
  sessionID: SessionID,
  resetID: ID,
  recoveryCellIncarnationID: Request.fields.recoveryCellIncarnationID,
  throughEventSeq: EventCursor,
  policy: Policy,
  reason: Reason,
  cancelInputIDs: Schema.Array(SessionMessage.ID),
  notStartedInputIDs: Schema.Array(SessionMessage.ID),
  tools: Schema.Array(ToolTarget),
  turn: TurnTarget.pipe(optional),
  preservedInputIDs: Schema.Array(SessionMessage.ID),
}).annotate({ identifier: "SessionReset.Plan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const Outcome = Schema.Struct({
  schema: Request.fields.schema,
  sessionID: SessionID,
  resetID: ID,
  recoveryCellIncarnationID: Request.fields.recoveryCellIncarnationID,
  throughEventSeq: EventCursor,
  policy: Policy,
  reason: Reason,
  canceledInputIDs: Schema.Array(SessionMessage.ID),
  notStarted: Schema.Array(InputClosure),
  tools: Schema.Array(ToolClosure),
  turn: TurnClosure.pipe(Schema.optional),
  preservedInputIDs: Schema.Array(SessionMessage.ID),
  idle: Schema.Boolean,
}).annotate({ identifier: "SessionReset.Outcome" })
export interface Outcome extends Schema.Schema.Type<typeof Outcome> {}

export const Receipt = Schema.Struct({
  ...Outcome.fields,
  resetSeq: NonNegativeInt,
}).annotate({ identifier: "SessionReset.Receipt" })
export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}
