import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, LayerMap } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionModelSwitch } from "@opencode-ai/core/session/model-switch"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSelection } from "@opencode-ai/core/session/selection"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const providerID = ProviderV2.ID.make("managed-provider")
const modelID = ModelV2.ID.make("managed-model")
const exactModel = ModelV2.Ref.make({ providerID, id: modelID, variant: ModelV2.VariantID.make("default") })
const switchedModel = ModelV2.Ref.make({
  providerID,
  id: ModelV2.ID.make("managed-model-2"),
  variant: ModelV2.VariantID.make("default"),
})
const exactAgent = AgentV2.ID.make("build")
let connected = false
const wakeCalls: SessionV2.ID[] = []

const resolveConfigured: SessionSelection.Interface["resolveConfigured"] = (input) =>
  Effect.succeed({ agent: input.agent ?? exactAgent, model: input.model })
const resolveAvailable: SessionSelection.Interface["resolve"] = (input) => {
  const model = input.model ?? exactModel
  return connected
    ? Effect.succeed({ agent: input.agent ?? exactAgent, model })
    : Effect.fail(new SessionSelection.ModelUnavailableError({ model }))
}
const selection = SessionSelection.layerWith({ resolve: resolveAvailable, resolveConfigured })
const locations = Layer.effect(
  LocationServiceMap.Service,
  // The test intentionally supplies only the location service SessionV2 consumes.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  LayerMap.make((_ref: Location.Ref) => selection) as unknown as Effect.Effect<
    LayerMap.LayerMap<Location.Ref, LocationServices>
  >,
)
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
    wake: (sessionID) => Effect.sync(() => wakeCalls.push(sessionID)),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
      [LocationServiceMap.node, locations],
    ],
  ),
)

const countInputs = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const countPromptAdmissions = Database.Service.use(({ db }) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)

describe("managed session provider admission", () => {
  it.effect("keeps selection durable but rejects a disconnected prompt before admission", () =>
    Effect.gen(function* () {
      connected = false
      wakeCalls.length = 0
      const session = yield* SessionV2.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make("/managed-project") })

      expect(
        yield* session
          .create({ location, agent: exactAgent, model: exactModel })
          .pipe(Effect.flip, Effect.map((error) => error._tag)),
      ).toBe("SessionSelection.ModelUnavailableError")

      const created = yield* session.create({
        location,
        agent: exactAgent,
        model: exactModel,
        executionManaged: true,
      })
      expect(created).toMatchObject({ agent: exactAgent, model: exactModel, execution: { managed: true } })

      const messageID = SessionMessage.ID.create()
      const failure = yield* session
        .prompt({ sessionID: created.id, id: messageID, prompt: Prompt.make({ text: "needs provider" }) })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({
        _tag: "Session.ProviderConnectionRequiredError",
        providerID,
        modelID,
        variant: "default",
      })
      expect(yield* countInputs).toBe(0)
      expect(yield* countPromptAdmissions).toBe(0)
      expect(wakeCalls).toEqual([])

      connected = true
      expect(
        yield* session.prompt({
          sessionID: created.id,
          id: messageID,
          prompt: Prompt.make({ text: "needs provider" }),
        }),
      ).toMatchObject({ id: messageID })
      expect(yield* countInputs).toBe(1)
      expect(yield* countPromptAdmissions).toBe(1)
      expect(wakeCalls).toEqual([created.id])

      connected = false
      yield* session.switchModel({ sessionID: created.id, model: switchedModel })
      expect(yield* SessionModelSwitch.pending((yield* Database.Service).db, created.id)).toMatchObject({
        model: switchedModel,
      })
    }),
  )
})
