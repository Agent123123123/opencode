import { Cause, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../database/database"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionInput } from "../input"
import { SessionModelSwitch } from "../model-switch"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionTable } from "../sql"

export const closeManagedExecutionGates = Effect.fn("SessionExecutionLocal.closeManagedExecutionGates")(function* (
  db: Database.Interface["db"],
) {
  yield* db
    .update(SessionTable)
    .set({ execution_gate_open: false, execution_gate_reason: "host_process_started" })
    .where(eq(SessionTable.execution_managed, true))
    .run()
    .pipe(Effect.orDie)
})

export const reconcilePending = Effect.fn("SessionExecutionLocal.reconcilePending")(function* (
  db: Database.Interface["db"],
  wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>,
) {
  const sessionIDs = Array.from(
    new Set([
      ...(yield* SessionInput.pendingSessionIDs(db)),
      ...(yield* SessionInput.orphanedPromotedSessionIDs(db)),
      ...(yield* SessionModelSwitch.pendingSessionIDs(db)),
    ]),
  )
  yield* Effect.forEach(sessionIDs, wake, { discard: true })
  return sessionIDs.length
})

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    yield* closeManagedExecutionGates(db)
    yield* reconcilePending(db, coordinator.wake)

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [Database.node, SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
