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

export const CompletionContractOrigin = Schema.Literals(["builtin", "controller"])
export type CompletionContractOrigin = typeof CompletionContractOrigin.Type

export const OrdinaryStopCompletionContract = Schema.Struct({
  schema: Schema.Literal("opencode.managed_completion.v1"),
  mode: Schema.Literal("ordinary_stop"),
}).annotate({ identifier: "SessionInput.OrdinaryStopCompletionContract" })
export interface OrdinaryStopCompletionContract extends Schema.Schema.Type<typeof OrdinaryStopCompletionContract> {}

const TerminalToolName = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(128)),
)

const CorrectionInstruction = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(4096)),
)

export const RequiredTerminalToolCompletionContract = Schema.Struct({
  schema: Schema.Literal("opencode.managed_completion.v1"),
  mode: Schema.Literal("required_terminal_tool"),
  terminalTools: Schema.Array(TerminalToolName).check(Schema.isMinLength(1)),
  correction: Schema.Struct({
    maxSteps: Schema.Literal(1),
    instruction: CorrectionInstruction,
  }),
}).annotate({ identifier: "SessionInput.RequiredTerminalToolCompletionContract" })
export interface RequiredTerminalToolCompletionContract
  extends Schema.Schema.Type<typeof RequiredTerminalToolCompletionContract> {}

export const CompletionContract = Schema.Union([
  OrdinaryStopCompletionContract,
  RequiredTerminalToolCompletionContract,
]).annotate({ identifier: "SessionInput.CompletionContract" })
export type CompletionContract = typeof CompletionContract.Type

export const CompletionContractDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  Schema.brand("SessionInput.CompletionContractDigest"),
)
export type CompletionContractDigest = typeof CompletionContractDigest.Type

export const Completion = Schema.Struct({
  origin: CompletionContractOrigin,
  contract: CompletionContract,
  digest: CompletionContractDigest,
}).annotate({ identifier: "SessionInput.Completion" })
export interface Completion extends Schema.Schema.Type<typeof Completion> {}

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  completion: Completion.pipe(optional),
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
