import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
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
import { ManagedSessionAuthority } from "@opencode-ai/core/session/authority"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionReset } from "@opencode-ai/schema/session-reset"
import { sessionSelectionLocations } from "./session-selection"

const [phase, filename, marker] = process.argv.slice(2)
assert.ok(phase === "admit" || phase === "reset")
assert.ok(filename && marker)
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [
    [Database.node, Database.layerFromPath(filename)],
    [ProjectV2.node, Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
      resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
      directories: () => Effect.succeed([]), commit: () => Effect.void,
    }))],
    // Hold the advisory scheduler, not admission or reset. The parent kills
    // this process only after the real durable Input commit is observable.
    [SessionExecution.node, Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
      active: Effect.succeed(new Set<SessionV2.ID>()), resume: () => Effect.void,
      interrupt: () => Effect.void, wake: () => Effect.void,
    }))],
    [LocationServiceMap.node, sessionSelectionLocations],
  ],
)
const reference = (generation: string) => SessionInput.ManagedExecutionRef.make({
  schema: "motryx.managed_execution.v4", origin: "FRAMEWORK", productSessionID: SessionV2.ID.make("ses_product_crash"),
  purpose: "coordinator",
  owner: { kind: "FUNCTION_SLOT", id: "slot_worker_crash", generation: 1 },
  checkpoint: { kind: "LANE", id: "lane_worker_crash" },
  cell: { supervisorIncarnationID: `supervisor_${generation}`, hostIncarnationID: `host_${generation}`,
    sidecarIncarnationID: `sidecar_${generation}` },
  claimID: `claim_${generation}`,
})
const oldInputID = SessionMessage.ID.make("msg_worker_before_crash")
const prompt = Prompt.make({ text: "work on the stable Lane checkpoint" })
const completionContract = SessionInput.RequiredTerminalToolCompletionContract.make({
  schema: "opencode.managed_completion.v1", mode: "required_terminal_tool", terminalTools: ["submit"],
  correction: { maxSteps: 1, instruction: "submit" },
})

await Effect.gen(function* () {
  const session = yield* SessionV2.Service
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  if (phase === "admit") {
    const created = yield* session.create({
      location: Location.Ref.make({ directory: AbsolutePath.make("/worker-crash-test") }),
      agent: AgentV2.ID.make("build"), executionManaged: true,
      model: ModelV2.Ref.make({ id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test-provider"),
        variant: ModelV2.VariantID.make("default") }),
    })
    const ref = reference("old")
    ManagedSessionAuthority.grant(created.id)
    assert.equal(ManagedSessionAuthority.authorizeInput({ sessionID: created.id, inputID: oldInputID,
      claimID: ref.claimID!, cell: ref.cell!, managedExecutionRef: ref }), "authorized")
    yield* session.setExecutionGate({ sessionID: created.id, open: true, reason: "old cell ready" })
    yield* session.prompt({ sessionID: created.id, id: oldInputID, prompt, completionContract,
      managedExecution: reference("old"), resume: true })
    assert.equal((yield* session.input({ sessionID: created.id, inputID: oldInputID })).state, "admitted")
    yield* Effect.promise(() => Bun.write(marker, JSON.stringify({ sessionID: created.id })))
    yield* Effect.never
    return
  }
  const saved = yield* Effect.promise(() => Bun.file(marker).json())
  const sessionID = SessionV2.ID.make(saved.sessionID)
  assert.equal(ManagedSessionAuthority.has(sessionID), false, "old process authority must not survive")
  assert.equal((yield* session.input({ sessionID, inputID: oldInputID })).state, "admitted")
  const history = yield* session.history({ sessionID, limit: 100 })
  assert.ok(!history.events.some((event) => event.type === "session.turn.started"))
  yield* session.setExecutionGate({ sessionID, open: false, reason: "new cell reconciliation before reset" })
  const request = SessionReset.Request.make({ schema: "opencode.managed_execution_reset.v1",
    resetID: SessionReset.ID.make("rst_worker_crash"), recoveryCellIncarnationID: "cell_new",
    throughEventSeq: yield* EventV2.latestSequence(database.db, sessionID), policy: "worker_flush", reason: "process_lost" })
  const receipt = yield* session.resetExecution({ sessionID, request })
  assert.deepEqual(receipt.canceledInputIDs, [oldInputID])
  assert.deepEqual(receipt.preservedInputIDs, [])
  assert.equal(receipt.idle, true)
  assert.deepEqual(yield* session.resetExecution({ sessionID, request }), receipt)
  assert.equal((yield* session.input({ sessionID, inputID: oldInputID })).state, "canceled")
  const replay = yield* session.prompt({ sessionID, id: oldInputID, prompt, completionContract,
    managedExecution: reference("old"), resume: true }).pipe(Effect.flip)
  assert.ok(replay instanceof SessionV2.PromptConflictError)
  assert.equal((yield* session.input({ sessionID, inputID: oldInputID })).state, "canceled")
  const fresh = yield* session.prompt({ sessionID, id: SessionMessage.ID.make("msg_worker_after_crash"),
    prompt, completionContract, managedExecution: reference("new"), resume: true })
  const ref = reference("new")
  ManagedSessionAuthority.grant(sessionID)
  assert.equal(ManagedSessionAuthority.authorizeInput({ sessionID, inputID: fresh.id,
    claimID: ref.claimID!, cell: ref.cell!, managedExecutionRef: ref }), "authorized")
  yield* session.setExecutionGate({ sessionID, open: true, reason: "new cell reset proven" })
  assert.equal(yield* SessionInput.promoteNextQueued(database.db, events, sessionID), true)
  assert.equal((yield* session.input({ sessionID, inputID: fresh.id })).state, "promoted")
  assert.equal((yield* session.input({ sessionID, inputID: oldInputID })).state, "canceled")
  assert.equal(yield* SessionInput.promoteNextQueued(database.db, events, sessionID), false)
  console.log("PASS: worker admission survives crash only as canceled history; fresh Input owns promotion")
}).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
