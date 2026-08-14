export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export const CancelOrigin = Schema.Literals(["user", "framework", "runtime_shutdown", "stale", "business"])
export type CancelOrigin = typeof CancelOrigin.Type

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })

export const Status = Schema.Union([
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    state: Schema.Literal("admitted"),
    input: Admitted,
  }),
  Schema.Struct({
    state: Schema.Literal("promoted"),
    input: Admitted,
  }),
  Schema.Struct({
    state: Schema.Literal("canceled"),
    id: SessionMessage.ID,
    sessionID: SessionID,
    cancelSeq: NonNegativeInt,
    origin: CancelOrigin,
    reason: Schema.String,
    timeCanceled: DateTimeUtcFromMillis,
    inputVisibility: Schema.Literals(["missing", "admitted_unpromoted"]),
  }),
]).annotate({ identifier: "SessionInput.Status" })
export type Status = typeof Status.Type

export const CancelResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("canceled"),
    status: Status,
  }),
  Schema.Struct({
    outcome: Schema.Literal("too_late"),
    status: Status,
  }),
]).annotate({ identifier: "SessionInput.CancelResult" })
export type CancelResult = typeof CancelResult.Type
