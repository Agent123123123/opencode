import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { ManagedSessionAuthority } from "@opencode-ai/core/session/authority"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionReset } from "@opencode-ai/schema/session-reset"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { sessionSelectionLocations } from "./fixture/session-selection"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<SessionV2.ID>()),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
      [LocationServiceMap.node, sessionSelectionLocations],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/managed-reset") })
const model = ModelV2.Ref.make({
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test-provider"),
  variant: ModelV2.VariantID.make("default"),
})

function authorizeDirectInput(sessionID: SessionV2.ID, inputID: SessionMessage.ID) {
  const claimID = `claim_${inputID}`
  const cell = {
    supervisorIncarnationID: "supervisor_reset_test",
    hostIncarnationID: "host_reset_test",
    sidecarIncarnationID: "sidecar_reset_test",
  }
  ManagedSessionAuthority.grant(sessionID)
  expect(ManagedSessionAuthority.authorizeInput({
    sessionID,
    inputID,
    claimID,
    cell,
    managedExecutionRef: SessionInput.ManagedExecutionRef.make({
      schema: "motryx.managed_execution.v4",
      purpose: "orchestrator",
      origin: "DIRECT_USER",
      productSessionID: sessionID,
      owner: { kind: "CONTROL_ROLE", id: sessionID, generation: 1 },
      checkpoint: { kind: "CONTROL", id: sessionID },
      cell,
      claimID,
    }),
  })).toBe("authorized")
}

describe("managed Session execution reset", () => {
  it.effect("requires an exact process-local Input grant even when the durable Session gate is open", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const input = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "grant me exactly once" }),
        resume: false,
      })
      yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "coarse recovery barrier open" })
      ManagedSessionAuthority.grant(created.id)

      expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(false)
      authorizeDirectInput(created.id, input.id)
      expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
      ManagedSessionAuthority.revoke(created.id)
      expect(ManagedSessionAuthority.has(created.id)).toBe(false)
    }),
  )

  it.effect("accepts the empty-history cursor and creates a durable idle receipt", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const receipt = yield* session.resetExecution({
        sessionID: created.id,
        request: SessionReset.Request.make({
          schema: "opencode.managed_execution_reset.v1",
          resetID: SessionReset.ID.make("rst_empty_history"),
          recoveryCellIncarnationID: "cell_new",
          throughEventSeq: -1,
          policy: "worker_flush",
          reason: "process_lost",
        }),
      })

      expect(receipt).toMatchObject({ throughEventSeq: -1, canceledInputIDs: [], idle: true })
    }),
  )

  it.effect("cancels admitted work, closes orphaned promotion, and returns one idempotent receipt", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const promoted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "old promoted work" }),
        resume: false,
      })
      authorizeDirectInput(created.id, promoted.id)
      yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "test promotion" })
      expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
      yield* session.setExecutionGate({ sessionID: created.id, open: false, reason: "test reset" })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "old admitted work" }),
        resume: false,
      })
      const throughEventSeq = yield* EventV2.latestSequence(database.db, created.id)
      const request = SessionReset.Request.make({
        schema: "opencode.managed_execution_reset.v1",
        resetID: SessionReset.ID.make("rst_worker_queue"),
        recoveryCellIncarnationID: "cell_new",
        throughEventSeq,
        policy: "worker_flush",
        reason: "process_lost",
      })

      const receipt = yield* session.resetExecution({ sessionID: created.id, request })
      expect(receipt).toMatchObject({
        canceledInputIDs: [admitted.id],
        notStarted: [{ inputID: promoted.id, turnID: expect.stringMatching(/^msg_reset_/) }],
        tools: [],
        preservedInputIDs: [],
        idle: true,
      })
      expect((yield* session.input({ sessionID: created.id, inputID: admitted.id })).state).toBe("canceled")
      expect((yield* session.input({ sessionID: created.id, inputID: promoted.id })).state).toBe("promoted")
      expect(yield* SessionInput.hasOrphanedPromoted(database.db, created.id)).toBe(false)
      expect(yield* session.resetExecution({ sessionID: created.id, request })).toEqual(receipt)

      const history = yield* session.history({ sessionID: created.id, limit: 100 })
      expect(history.events.filter((event) => event.type === SessionEvent.ExecutionReset.type)).toHaveLength(1)
      expect(history.events.filter((event) => event.type === SessionEvent.Turn.NotStarted.type)).toHaveLength(1)
    }),
  )

  it.effect("rejects reset when an Input was admitted after the exact cut", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const throughEventSeq = yield* EventV2.latestSequence(database.db, created.id)
      yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "arrived after cut" }),
        resume: false,
      })

      const error = yield* session.resetExecution({
        sessionID: created.id,
        request: SessionReset.Request.make({
          schema: "opencode.managed_execution_reset.v1",
          resetID: SessionReset.ID.make("rst_post_cut"),
          recoveryCellIncarnationID: "cell_new",
          throughEventSeq,
          policy: "worker_flush",
          reason: "runtime_shutdown",
        }),
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: "SessionReset.Conflict",
        reason: "Session contains an Input after the reset cut",
      })
    }),
  )

  it.effect("resumes the same durable plan after interruption and returns the complete closure receipt", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const promoted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "planned promoted work" }),
        resume: false,
      })
      authorizeDirectInput(created.id, promoted.id)
      yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "test promotion" })
      expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
      yield* session.setExecutionGate({ sessionID: created.id, open: false, reason: "test reset" })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "planned admitted work" }),
        resume: false,
      })
      const request = SessionReset.Request.make({
        schema: "opencode.managed_execution_reset.v1",
        resetID: SessionReset.ID.make("rst_interrupted_plan"),
        recoveryCellIncarnationID: "cell_new",
        throughEventSeq: yield* EventV2.latestSequence(database.db, created.id),
        policy: "worker_flush",
        reason: "process_lost",
      })
      let interrupt = true
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== SessionEvent.ExecutionResetStarted.type || !interrupt) return Effect.void
        interrupt = false
        return Effect.interrupt
      })
      const first = yield* session.resetExecution({ sessionID: created.id, request }).pipe(Effect.exit)
      yield* unsubscribe
      expect(Exit.isFailure(first)).toBe(true)

      const receipt = yield* session.resetExecution({ sessionID: created.id, request })
      expect(receipt).toMatchObject({
        canceledInputIDs: [admitted.id],
        notStarted: [{ inputID: promoted.id }],
        idle: true,
      })
      const history = yield* session.history({ sessionID: created.id, limit: 100 })
      expect(history.events.filter((event) => event.type === SessionEvent.ExecutionResetStarted.type)).toHaveLength(1)
      expect(history.events.filter((event) => event.type === SessionEvent.ExecutionReset.type)).toHaveLength(1)
    }),
  )

  for (const [label, interruptedType] of [
    ["plan", SessionEvent.ExecutionResetStarted.type],
    ["input cancellation", SessionEvent.PromptCanceled.type],
    ["NotStarted closure", SessionEvent.Turn.NotStarted.type],
    ["receipt", SessionEvent.ExecutionReset.type],
  ] as const) {
    it.effect(`converges after a kill immediately after the durable ${label} write`, () =>
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const created = yield* session.create({
          location,
          agent: AgentV2.ID.make("build"),
          model,
          executionManaged: true,
        })
        const promoted = yield* session.prompt({
          sessionID: created.id,
          prompt: Prompt.make({ text: `promoted before ${label}` }),
          resume: false,
        })
        authorizeDirectInput(created.id, promoted.id)
        yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "test promotion" })
        expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
        yield* session.setExecutionGate({ sessionID: created.id, open: false, reason: "test reset" })
        const admitted = yield* session.prompt({
          sessionID: created.id,
          prompt: Prompt.make({ text: `admitted before ${label}` }),
          resume: false,
        })
        const request = SessionReset.Request.make({
          schema: "opencode.managed_execution_reset.v1",
          resetID: SessionReset.ID.make(`rst_kill_${label.replaceAll(" ", "_")}`),
          recoveryCellIncarnationID: "cell_after_kill",
          throughEventSeq: yield* EventV2.latestSequence(database.db, created.id),
          policy: "worker_flush",
          reason: "process_lost",
        })
        let interrupt = true
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== interruptedType || !interrupt) return Effect.void
          interrupt = false
          return Effect.interrupt
        })
        expect(Exit.isFailure(yield* session.resetExecution({ sessionID: created.id, request }).pipe(Effect.exit))).toBe(true)
        yield* unsubscribe
        const receipt = yield* session.resetExecution({ sessionID: created.id, request })
        expect(receipt).toMatchObject({
          canceledInputIDs: [admitted.id],
          notStarted: [{ inputID: promoted.id }],
          idle: true,
        })
        const history = yield* session.history({ sessionID: created.id, limit: 100 })
        expect(history.events.filter((event) => event.type === SessionEvent.ExecutionResetStarted.type)).toHaveLength(1)
        expect(history.events.filter((event) => event.type === SessionEvent.PromptCanceled.type)).toHaveLength(1)
        expect(history.events.filter((event) => event.type === SessionEvent.Turn.NotStarted.type)).toHaveLength(1)
        expect(history.events.filter((event) => event.type === SessionEvent.ExecutionReset.type)).toHaveLength(1)
      }),
    )
  }

  it.effect("preserves primary direct-user FIFO while canceling framework work", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const promotedUser = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "durable user request" }),
        resume: true,
      })
      authorizeDirectInput(created.id, promotedUser.id)
      yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "test promotion" })
      expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
      yield* session.setExecutionGate({ sessionID: created.id, open: false, reason: "test reset" })
      const queuedUser = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "later user request" }),
        resume: true,
      })
      const admitOnlyProbe = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "admission-only probe" }),
        resume: false,
      })
      const framework = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "stale framework request" }),
        completionContract: SessionInput.RequiredTerminalToolCompletionContract.make({
          schema: "opencode.managed_completion.v1",
          mode: "required_terminal_tool",
          terminalTools: ["submit"],
          correction: { maxSteps: 1, instruction: "submit" },
        }),
        managedExecution: SessionInput.ManagedExecutionRef.make({
          schema: "motryx.managed_execution.v4",
          purpose: "orchestrator",
          origin: "FRAMEWORK",
          productSessionID: created.id,
          owner: { kind: "CONTROL_ROLE", id: "control_owner_reset_test", generation: 1 },
          checkpoint: { kind: "CONTROL", id: "control_owner_reset_test" },
          cell: {
            supervisorIncarnationID: "supervisor_test",
            hostIncarnationID: "host_test",
            sidecarIncarnationID: "sidecar_test",
          },
          claimID: "run_reset_test",
        }),
        resume: false,
      })
      const throughEventSeq = yield* EventV2.latestSequence(database.db, created.id)

      const receipt = yield* session.resetExecution({
        sessionID: created.id,
        request: SessionReset.Request.make({
          schema: "opencode.managed_execution_reset.v1",
          resetID: SessionReset.ID.make("rst_primary_fifo"),
          recoveryCellIncarnationID: "cell_new",
          throughEventSeq,
          policy: "primary_preserve_user",
          reason: "process_lost",
        }),
      })

      expect(receipt).toMatchObject({
        canceledInputIDs: [admitOnlyProbe.id, framework.id],
        notStarted: [],
        preservedInputIDs: [promotedUser.id, queuedUser.id],
        idle: true,
      })
      expect((yield* session.input({ sessionID: created.id, inputID: framework.id })).state).toBe("canceled")
      const history = yield* session.history({ sessionID: created.id, limit: 100 })
      const canceled = history.events.find((event) =>
        event.type === SessionEvent.PromptCanceled.type && event.data.messageID === framework.id,
      )
      expect(framework.completion?.managedExecution).toBeDefined()
      expect(canceled?.type).toBe(SessionEvent.PromptCanceled.type)
      if (canceled?.type === SessionEvent.PromptCanceled.type) {
        expect(canceled.data.managedExecution).toEqual(framework.completion?.managedExecution)
      }
      expect((yield* session.input({ sessionID: created.id, inputID: admitOnlyProbe.id })).state).toBe("canceled")
      expect((yield* session.input({ sessionID: created.id, inputID: queuedUser.id })).state).toBe("admitted")
      expect((yield* session.input({ sessionID: created.id, inputID: promotedUser.id })).state).toBe("promoted")
      expect((yield* SessionInput.orphanedPromotedThrough(
        database.db,
        created.id,
        Number.MAX_SAFE_INTEGER,
      )).map((input) => input.id)).toEqual([promotedUser.id])
    }),
  )

  it.effect("closes an active Turn with an unresolved called tool as outcome unknown", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model,
        executionManaged: true,
      })
      const input = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "run an effect" }),
        resume: false,
      })
      authorizeDirectInput(created.id, input.id)
      yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "test promotion" })
      expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
      yield* session.setExecutionGate({ sessionID: created.id, open: false, reason: "test reset" })
      const turnID = SessionMessage.ID.make("msg_reset_active_turn")
      const assistantMessageID = SessionMessage.ID.make("msg_reset_active_assistant")
      const now = yield* DateTime.now
      yield* events.publish(SessionEvent.Turn.Started, {
        sessionID: created.id,
        timestamp: now,
        turnID,
        turnStartedAt: now,
        activityInputIDs: [input.id],
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        timestamp: now,
        assistantMessageID,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: created.id,
        timestamp: now,
        assistantMessageID,
        callID: "call-effect",
        turnID,
        activityInputIDs: [input.id],
        name: "effect",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID: created.id,
        timestamp: now,
        assistantMessageID,
        callID: "call-effect",
        turnID,
        activityInputIDs: [input.id],
        tool: "effect",
        input: {},
        provider: { executed: false },
      })
      const throughEventSeq = yield* EventV2.latestSequence(database.db, created.id)

      const receipt = yield* session.resetExecution({
        sessionID: created.id,
        request: SessionReset.Request.make({
          schema: "opencode.managed_execution_reset.v1",
          resetID: SessionReset.ID.make("rst_active_tool"),
          recoveryCellIncarnationID: "cell_new",
          throughEventSeq,
          policy: "worker_flush",
          reason: "process_lost",
        }),
      })

      expect(receipt).toMatchObject({
        tools: [{ callID: "call-effect", outcome: "outcome_unknown" }],
        turn: { turnID, outcome: "outcome_unknown" },
        idle: true,
      })
      expect(
        yield* database.db
          .select({ activeTurnID: SessionTable.active_turn_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ activeTurnID: null })
    }),
  )

  for (const [label, interruptedType] of [
    ["tool closure", SessionEvent.Tool.Failed.type],
    ["Turn closure", SessionEvent.Turn.Settled.type],
  ] as const) {
    it.effect(`converges after a kill immediately after the durable ${label}`, () =>
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const created = yield* session.create({ location, agent: AgentV2.ID.make("build"), model, executionManaged: true })
        const input = yield* session.prompt({
          sessionID: created.id,
          prompt: Prompt.make({ text: `effect before ${label}` }),
          resume: false,
        })
        authorizeDirectInput(created.id, input.id)
        yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "test promotion" })
        expect(yield* SessionInput.promoteNextQueued(database.db, events, created.id)).toBe(true)
        yield* session.setExecutionGate({ sessionID: created.id, open: false, reason: "test reset" })
        const turnID = SessionMessage.ID.make(`msg_kill_${label.replaceAll(" ", "_")}`)
        const assistantMessageID = SessionMessage.ID.make(`msg_assistant_kill_${label.replaceAll(" ", "_")}`)
        const now = yield* DateTime.now
        yield* events.publish(SessionEvent.Turn.Started, {
          sessionID: created.id, timestamp: now, turnID, turnStartedAt: now, activityInputIDs: [input.id],
        })
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: created.id, timestamp: now, assistantMessageID, agent: "build", model,
        })
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          sessionID: created.id, timestamp: now, assistantMessageID, callID: "call-kill-effect",
          turnID, activityInputIDs: [input.id], name: "effect",
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: created.id, timestamp: now, assistantMessageID, callID: "call-kill-effect",
          turnID, activityInputIDs: [input.id], tool: "effect", input: {}, provider: { executed: false },
        })
        const request = SessionReset.Request.make({
          schema: "opencode.managed_execution_reset.v1",
          resetID: SessionReset.ID.make(`rst_kill_${label.replaceAll(" ", "_")}`),
          recoveryCellIncarnationID: "cell_after_tool_kill",
          throughEventSeq: yield* EventV2.latestSequence(database.db, created.id),
          policy: "worker_flush",
          reason: "process_lost",
        })
        let interrupt = true
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== interruptedType || !interrupt) return Effect.void
          interrupt = false
          return Effect.interrupt
        })
        expect(Exit.isFailure(yield* session.resetExecution({ sessionID: created.id, request }).pipe(Effect.exit))).toBe(true)
        yield* unsubscribe
        const receipt = yield* session.resetExecution({ sessionID: created.id, request })
        expect(receipt).toMatchObject({
          tools: [{ callID: "call-kill-effect", outcome: "outcome_unknown" }],
          turn: { turnID, outcome: "outcome_unknown" },
          idle: true,
        })
        const history = yield* session.history({ sessionID: created.id, limit: 100 })
        expect(history.events.filter((event) => event.type === SessionEvent.Tool.Failed.type)).toHaveLength(1)
        expect(history.events.filter((event) => event.type === SessionEvent.Turn.Settled.type)).toHaveLength(1)
        expect(history.events.filter((event) => event.type === SessionEvent.ExecutionReset.type)).toHaveLength(1)
      }),
    )
  }
})
