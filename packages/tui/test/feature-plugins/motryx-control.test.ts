import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  MotryxControlHttpError,
  MotryxControlSchemaError,
  fetchMotryxControlSnapshot,
  motryxControlConfigFromEnv,
  parseMotryxControlSnapshot,
  type MotryxControlConfig,
} from "../../src/feature-plugins/motryx/control"

const projectID = path.resolve("/tmp/motryx-project")
const config: MotryxControlConfig = {
  apiURL: "http://127.0.0.1:19000/base",
  token: "control-token",
  projectID,
  orchestratorSessionID: "ses_orchestrator",
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const now = "2026-07-19T00:00:00.000Z"
  return {
    schemaVersion: 2,
    projectID,
    orchestratorSessionID: config.orchestratorSessionID,
    projectionRevision: "server-generation:ic:revision",
    route: {
      state: "ROUTABLE",
      serverGeneration: "server-generation",
      sidecarGeneration: "server-generation",
      bindingGeneration: 7,
      reconciledThrough: {
        sessionID: config.orchestratorSessionID,
        seq: 12,
        eventID: "evt_12",
      },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID: config.orchestratorSessionID,
      runtimeID: "runtime_public",
      bindingState: "ACTIVE",
      bindingGeneration: 7,
      ownerRunID: "run_public",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    workflow: {
      id: "wf_1",
      status: "ACTIVE",
      goal: "migrate the product boundary",
    },
    lanes: [],
    agents: [],
    artifacts: [],
    resourceBlocks: [],
    functionSlots: [],
    inboxItems: [],
    deliveryFences: [],
    diagnostics: [],
    ...overrides,
  }
}

describe("Motryx typed control snapshot", () => {
  test("reads only explicit launcher inputs from the environment", () => {
    expect(
      motryxControlConfigFromEnv({
        MOTRYX_CONTROL_API_URL: config.apiURL,
        MOTRYX_CONTROL_API_TOKEN: config.token,
        MOTRYX_PROJECT_DIR: projectID,
        MOTRYX_ORCHESTRATOR_SESSION_ID: config.orchestratorSessionID,
      }),
    ).toEqual({ ok: true, value: config })
    expect(motryxControlConfigFromEnv({})).toEqual({ ok: false, error: "MOTRYX_CONTROL_API_URL is missing" })
    expect(
      motryxControlConfigFromEnv({
        MOTRYX_CONTROL_API_URL: "file:///tmp/socket",
        MOTRYX_CONTROL_API_TOKEN: "x",
        MOTRYX_PROJECT_DIR: projectID,
        MOTRYX_ORCHESTRATOR_SESSION_ID: "ses",
      }),
    ).toEqual({ ok: false, error: "Motryx control API must use http or https" })
  })

  test("accepts an exact schema-v2 ROUTABLE/binding/reconcile proof", () => {
    expect(parseMotryxControlSnapshot(snapshot(), config)).toMatchObject({
      schemaVersion: 2,
      projectID,
      orchestratorSessionID: config.orchestratorSessionID,
      projectionRevision: "server-generation:ic:revision",
      route: {
        state: "ROUTABLE",
        bindingGeneration: 7,
        reconciledThrough: { seq: 12, eventID: "evt_12" },
      },
      binding: { bindingState: "ACTIVE", bindingGeneration: 7 },
      workflow: { id: "wf_1" },
    })
  })

  test("accepts the slot-runtime workflow projection wire shape", () => {
    const value = parseMotryxControlSnapshot(
      snapshot({
        lanes: [
          {
            id: "lane_1",
            name: "Implement",
            status: "WORKING",
            updatedAt: "2026-07-19T00:00:00.000Z",
            reopenCount: 0,
            repairCycle: 0,
            dependsOnLaneIDs: [],
            coordinatorSlotID: "slot_coordinator",
            coordinatorRuntimeReadiness: "ready",
            checkerRuntimeReadiness: "unmaterialized",
            coordinatorRuntime: {
              slotID: "slot_coordinator",
              instanceID: "inst_coordinator",
              sessionID: "ses_coordinator",
            },
          },
        ],
        functionSlots: [
          {
            slotID: "slot_coordinator",
            slotKey: "lane-lane_1-coordinator",
            role: "coordinator",
            runtimeReadiness: "ready",
          },
        ],
        inboxItems: [
          {
            inboxItemID: "inbox_1",
            targetKind: "slot",
            targetID: "slot_coordinator",
            envelopeClass: "command",
            sourceType: "lane_command",
            status: "ACTIVE",
            laneID: "lane_1",
          },
        ],
      }),
      config,
    )

    expect(value.lanes[0]).toMatchObject({
      coordinatorSlotID: "slot_coordinator",
      coordinatorRuntimeReadiness: "ready",
      checkerRuntimeReadiness: "unmaterialized",
      coordinatorRuntime: {
        slotID: "slot_coordinator",
        instanceID: "inst_coordinator",
        sessionID: "ses_coordinator",
      },
    })
    expect(value.functionSlots[0]).toMatchObject({ runtimeReadiness: "ready" })
    expect(value.inboxItems[0]).toMatchObject({ targetKind: "slot", targetID: "slot_coordinator" })
  })

  test("fails closed on schema, identity, generation, and reconcile mismatches", () => {
    expect(() => parseMotryxControlSnapshot(snapshot({ schemaVersion: 1 }), config)).toThrow(MotryxControlSchemaError)
    expect(() => parseMotryxControlSnapshot(snapshot({ projectID: "/tmp/other" }), config)).toThrow(
      "snapshot.projectID does not match",
    )
    expect(() =>
      parseMotryxControlSnapshot(snapshot({ binding: { ...snapshot().binding, bindingGeneration: 8 } }), config),
    ).toThrow("route and binding generation do not match")
    expect(() =>
      parseMotryxControlSnapshot(
        snapshot({
          route: {
            ...snapshot().route,
            reconciledThrough: { sessionID: config.orchestratorSessionID, seq: 12, eventID: null },
          },
        }),
        config,
      ),
    ).toThrow("eventID is required")
  })

  test("uses Bearer auth and reports HTTP/content-type failures by name", async () => {
    let request: Request | undefined
    const value = await fetchMotryxControlSnapshot(config, {
      fetcher: async (input, init) => {
        request = new Request(input, init)
        return Response.json(snapshot())
      },
    })
    expect(value.workflow?.id).toBe("wf_1")
    expect(request?.headers.get("authorization")).toBe(`Bearer ${config.token}`)
    expect(new URL(request!.url).pathname).toBe("/ic/workflow")
    expect(new URL(request!.url).searchParams.get("orchestrator_session_id")).toBe(config.orchestratorSessionID)

    await expect(
      fetchMotryxControlSnapshot(config, { fetcher: async () => new Response("no", { status: 503 }) }),
    ).rejects.toEqual(expect.objectContaining({ name: "MotryxControlHttpError", status: 503 }))
    await expect(
      fetchMotryxControlSnapshot(config, { fetcher: async () => new Response("{}", { status: 200 }) }),
    ).rejects.toBeInstanceOf(MotryxControlSchemaError)
    expect(new MotryxControlHttpError(409, "conflict").name).toBe("MotryxControlHttpError")
  })
})
