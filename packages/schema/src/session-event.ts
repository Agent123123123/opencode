export * as SessionEvent from "./session-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { ProviderMetadata, ToolContent } from "./llm"
import { Delivery } from "./session-delivery"
import { Completion, CompletionContractDigest, ManagedExecutionRef } from "./session-input"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, RelativePath } from "./schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionID } from "./session-id"
import { Location } from "./location"
import { SessionMessage } from "./session-message"
import { SessionReset } from "./session-reset"
import { Title } from "./session-title"
import { Revert } from "./revert"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}
const PromptFields = {
  ...Base,
  messageID: SessionMessage.ID,
  prompt: Prompt,
  delivery: Delivery,
  completion: Completion.pipe(optional),
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const turnStartOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const turnNotStartedOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const promptOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const turnSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 3,
  },
} as const
const toolOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

export const UnknownError = SessionMessage.UnknownError
export type UnknownError = SessionMessage.UnknownError

export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    model: Model.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

/** Durable intent. The runner applies it at the next boundary for this Session. */
export const ModelSwitchRequested = Event.define({
  type: "session.next.model.switch.requested",
  ...options,
  schema: {
    ...Base,
    model: Model.Ref,
  },
})
export type ModelSwitchRequested = typeof ModelSwitchRequested.Type

export const TitleChanged = Event.define({
  type: "session.next.title.changed",
  ...options,
  schema: {
    ...Base,
    title: Title,
  },
})
export type TitleChanged = typeof TitleChanged.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(optional),
  },
})
export type Moved = typeof Moved.Type

export const ExecutionGateChanged = Event.define({
  type: "session.next.execution_gate.changed",
  ...options,
  schema: {
    ...Base,
    open: Schema.Boolean,
    reason: Schema.String,
  },
})
export type ExecutionGateChanged = typeof ExecutionGateChanged.Type

export const ExecutionResetStarted = Event.define({
  type: "session.next.execution.reset.started",
  ...options,
  schema: SessionReset.Plan.fields,
})
export type ExecutionResetStarted = typeof ExecutionResetStarted.Type

export const ExecutionReset = Event.define({
  type: "session.next.execution.reset",
  ...options,
  schema: SessionReset.Outcome.fields,
})
export type ExecutionReset = typeof ExecutionReset.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...promptOptions,
  schema: PromptFields,
})
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = Event.define({
  type: "session.next.prompt.admitted",
  ...promptOptions,
  schema: {
    ...PromptFields,
    resumeRequested: Schema.Boolean.pipe(optional),
  },
})
export type PromptAdmitted = typeof PromptAdmitted.Type

export const PromptCanceled = Event.define({
  type: "session.next.prompt.canceled",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    origin: Schema.Literals(["user", "framework", "runtime_shutdown", "stale", "business"]),
    reason: Schema.String,
    inputVisibility: Schema.Literals(["missing", "admitted_unpromoted"]),
    executionReset: SessionReset.Reference.pipe(optional),
  },
})
export type PromptCanceled = typeof PromptCanceled.Type

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export namespace Turn {
  export const Failure = Schema.Struct({
    kind: Schema.Literals([
      "authentication",
      "quota",
      "rate_limit",
      "provider_internal",
      "transport",
      "invalid_request",
      "content_policy",
      "resource_limit",
      "protocol_contract_unsatisfied",
      "tool_effect_unknown",
      "unknown",
    ]),
    safeMessage: Schema.String,
    httpStatus: Schema.Number.pipe(optional),
    transportKind: Schema.String.pipe(optional),
    transportCode: Schema.String.pipe(optional),
    retryable: Schema.Boolean,
    retryExhausted: Schema.Boolean,
    attemptCount: Schema.Number,
    providerID: Schema.String.pipe(optional),
    modelID: Schema.String.pipe(optional),
  })
  export type Failure = typeof Failure.Type

  export const Started = Event.define({
    type: "session.turn.started",
    ...turnStartOptions,
    schema: {
      ...Base,
      turnID: SessionMessage.ID,
      turnStartedAt: DateTimeUtcFromMillis,
      activityInputIDs: Schema.Array(SessionMessage.ID),
      completionContractDigest: CompletionContractDigest.pipe(optional),
      managedExecution: ManagedExecutionRef.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  /**
   * Durable proof that promoted inputs were consumed by a runner attempt but
   * execution never crossed the durable Turn.Started commit boundary.
   */
  export const NotStarted = Event.define({
    type: "session.turn.not_started",
    ...turnNotStartedOptions,
    schema: {
      ...Base,
      schema: Schema.Literal("opencode.turn_not_started.v2"),
      turnID: SessionMessage.ID,
      activityInputIDs: Schema.Array(SessionMessage.ID),
      outcome: Schema.Literals(["failed", "aborted", "interrupted"]),
      reason: Schema.String,
      errorClass: Schema.Literals(["transport", "resource", "protocol", "tool_unknown", "interrupt", "unknown"]),
      failure: Failure.pipe(optional),
      managedExecution: ManagedExecutionRef.pipe(optional),
      executionReset: SessionReset.Reference.pipe(optional),
    },
  })
  export type NotStarted = typeof NotStarted.Type

  export const Correction = Event.define({
    type: "session.turn.correction",
    ...options,
    schema: {
      ...Base,
      turnID: SessionMessage.ID,
      rootInputID: SessionMessage.ID,
      contractDigest: CompletionContractDigest,
      ordinal: Schema.Literal(1),
      reason: Schema.Literal("missing_required_terminal_tool"),
      instruction: Schema.String,
    },
  })
  export type Correction = typeof Correction.Type

  export const Completion = Schema.Union([
    Schema.Struct({
      mode: Schema.Literal("ordinary_stop"),
      correctionSteps: Schema.Literal(0),
    }),
    Schema.Struct({
      mode: Schema.Literal("required_terminal_tool"),
      correctionSteps: Schema.Literals([0, 1]),
      terminalTool: Schema.Struct({
        name: Schema.String,
        callID: Schema.String,
      }),
    }),
  ])
  export type Completion = typeof Completion.Type

  export const Settled = Event.define({
    type: "session.turn.settled",
    ...turnSettlementOptions,
    schema: {
      ...Base,
      schema: Schema.Literal("opencode.turn_settled.v3"),
      turnID: SessionMessage.ID,
      turnStartedAt: DateTimeUtcFromMillis,
      activityInputIDs: Schema.Array(SessionMessage.ID),
      outcome: Schema.Literals(["completed", "error", "aborted"]),
      reason: Schema.String.pipe(optional),
      errorClass: Schema.Literals(["transport", "resource", "protocol", "tool_unknown", "interrupt", "unknown"]).pipe(optional),
      abortOrigin: Schema.Literals(["user", "framework", "runtime_shutdown", "unknown"]).pipe(optional),
      failure: Failure.pipe(optional),
      completion: Completion.pipe(optional),
      providerWarning: Failure.pipe(optional),
      managedExecution: ManagedExecutionRef.pipe(optional),
      executionReset: SessionReset.Reference.pipe(optional),
    },
  })
  export type Settled = typeof Settled.Type
}

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      snapshot: Schema.String.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
    managedExecution: ManagedExecutionRef.pipe(optional),
  }
  const ToolIdentity = {
    turnID: SessionMessage.ID,
    activityInputIDs: Schema.Array(SessionMessage.ID),
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...toolOptions,
      schema: {
        ...ToolBase,
        ...ToolIdentity,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        ...ToolIdentity,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...toolOptions,
      schema: {
        ...ToolBase,
        ...ToolIdentity,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...toolOptions,
    schema: {
      ...ToolBase,
      ...ToolIdentity,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...toolOptions,
    schema: {
      ...ToolBase,
      ...ToolIdentity,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...toolOptions,
    schema: {
      ...ToolBase,
      ...ToolIdentity,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
      outputPaths: Schema.Array(Schema.String).pipe(optional),
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...toolOptions,
    schema: {
      ...ToolBase,
      turnID: SessionMessage.ID.pipe(optional),
      activityInputIDs: Schema.Array(SessionMessage.ID).pipe(optional),
      error: UnknownError,
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(optional),
  responseBody: Schema.String.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export interface RetryError extends Schema.Schema.Type<typeof RetryError> {}

export const Retried = Event.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

export namespace Compaction {
  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace RevertEvent {
  export const Staged = Event.define({
    type: "session.next.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert.State },
  })
  export const Cleared = Event.define({ type: "session.next.revert.cleared", ...options, schema: Base })
  export const Committed = Event.define({
    type: "session.next.revert.committed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID },
  })
}

export const DurableDefinitions = Event.inventory(
  AgentSwitched,
  ModelSwitchRequested,
  ModelSwitched,
  TitleChanged,
  Moved,
  Prompted,
  PromptAdmitted,
  PromptCanceled,
  ExecutionGateChanged,
  ExecutionResetStarted,
  ExecutionReset,
  ContextUpdated,
  Turn.Started,
  Turn.NotStarted,
  Turn.Correction,
  Turn.Settled,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Compaction.Started,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Definitions = Event.inventory(
  AgentSwitched,
  ModelSwitchRequested,
  ModelSwitched,
  TitleChanged,
  Moved,
  Prompted,
  PromptAdmitted,
  PromptCanceled,
  ExecutionGateChanged,
  ExecutionResetStarted,
  ExecutionReset,
  ContextUpdated,
  Turn.Started,
  Turn.NotStarted,
  Turn.Correction,
  Turn.Settled,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Retried,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
