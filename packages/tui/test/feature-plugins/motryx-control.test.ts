import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  MotryxControlHttpError,
  MotryxControlSchemaError,
  dismissMotryxIncident,
  fetchMotryxControlSnapshot,
  fetchMotryxSessions,
  motryxControlConfigFromEnv,
  parseMotryxControlSnapshot,
  parseMotryxRuntimeHealthWarnings,
  parseMotryxSessionList,
  switchMotryxSession,
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
    schemaVersion: 11,
    projectID,
    orchestratorSessionID: config.orchestratorSessionID,
    projectionRevision: "server-generation:ic:revision",
    runtimeCellEpoch: "host-generation:sidecar-generation",
    runtimeOverlayRevision: 1,
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
    capacity: {
      maxConcurrentLanes: 0,
      activeLaneIDs: [],
      activeCount: 0,
      available: null,
      capacityReached: false,
      readyLaneIDs: [],
    },
    lanes: [],
    agents: [],
    artifacts: [],
    resourceBlocks: [],
    incidents: [],
    attentionItems: [],
    runtimeWarnings: [],
    attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
    functionSlots: [],
    runtimeExecutions: [],
    executionHistory: [],
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

  test("accepts an exact schema-v11 ROUTABLE/binding/reconcile proof", () => {
    expect(parseMotryxControlSnapshot(snapshot(), config)).toMatchObject({
      schemaVersion: 11,
      projectID,
      orchestratorSessionID: config.orchestratorSessionID,
      projectionRevision: "server-generation:ic:revision",
      runtimeCellEpoch: "host-generation:sidecar-generation",
      runtimeOverlayRevision: 1,
      route: {
        state: "ROUTABLE",
        bindingGeneration: 7,
        reconciledThrough: { seq: 12, eventID: "evt_12" },
      },
      binding: { bindingState: "ACTIVE", bindingGeneration: 7 },
      workflow: { id: "wf_1" },
    })
  })

  test("accepts runtime claims and terminal-only execution history", () => {
    const value = parseMotryxControlSnapshot(
      snapshot({
        lanes: [
          {
            id: "lane_1",
            name: "Implement",
            status: "OPEN",
            stableStatus: "OPEN",
            displayStatus: "WORKING",
            updatedAt: "2026-07-19T00:00:00.000Z",
            reopenCount: 0,
            repairCycle: 0,
            dependsOnLaneIDs: [],
            coordinatorSlotID: "slot_coordinator",
            coordinatorRuntimeReadiness: "bound",
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
        runtimeExecutions: [{
          claimID: "claim_1",
          cellEpoch: "host_1:sidecar_1",
          workflowID: "wf_1",
          laneID: "lane_1",
          ownerID: "slot_coordinator",
          ownerGeneration: 1,
          bindingID: "binding_1",
          sessionID: "ses_coordinator",
          inputID: "input_1",
          turnID: "turn_1",
          role: "coordinator",
          phase: "WORKING",
          checkpointRevision: 0,
          createdAt: 1_786_510_000_000,
        }],
        executionHistory: [{
          summaryID: "summary_1",
          evidenceKey: "evidence_1",
          origin: "FRAMEWORK",
          productSessionID: "ses_orchestrator",
          ownerKind: "FUNCTION_SLOT",
          ownerID: "slot_coordinator",
          ownerGeneration: 1,
          workflowID: "wf_1",
          laneID: "lane_1",
          role: "coordinator",
          checkpointKind: "LANE",
          checkpointID: "lane_1",
          checkpointRevision: 0,
          sessionID: "ses_coordinator",
          inputID: "input_0",
          turnID: "turn_0",
          terminalKind: "COMPLETED",
          terminalEventID: "event_0",
          terminalProofRef: "proof_0",
          terminalAt: 1_786_509_999_999,
          createdAt: 1_786_510_000_000,
        }],
      }),
      config,
    )

    expect(value.lanes[0]).toMatchObject({
      coordinatorSlotID: "slot_coordinator",
      coordinatorRuntimeReadiness: "bound",
      checkerRuntimeReadiness: "unmaterialized",
      coordinatorRuntime: {
        slotID: "slot_coordinator",
        instanceID: "inst_coordinator",
        sessionID: "ses_coordinator",
      },
    })
    expect(value.functionSlots[0]).toMatchObject({ runtimeReadiness: "ready" })
    expect(value.runtimeExecutions[0]).toMatchObject({ claimID: "claim_1", phase: "WORKING" })
    expect(value.executionHistory[0]).toMatchObject({ summaryID: "summary_1", terminalKind: "COMPLETED" })
  })

  test("strictly parses current runtime attention and retry diagnostics", () => {
    const value = parseMotryxControlSnapshot(snapshot({
      attentionItems: [{
        attentionID: "attention_provider_retry",
        kind: "PROVIDER_RETRY",
        severity: "WARNING",
        scopeKind: "SESSION",
        role: "orchestrator",
        claimID: "claim_control",
        inputID: "input_control",
        summary: "Provider request failed with HTTP 503 and will retry.",
        reasonCode: "provider_internal",
        nextAction: "wait_for_provider_retry",
        actionRequired: false,
        dismissible: true,
        presentationState: "VISIBLE",
        createdAt: 1_786_510_000_000,
        retryLayer: "PROVIDER",
        retryAttempt: 2,
        retryLimit: 3,
        retryNotBefore: 1_786_510_002_000,
        failureKind: "provider_internal",
        httpStatus: 503,
        transportKind: "http-sse",
        transportCode: "UND_ERR_HEADERS_TIMEOUT",
        providerID: "zai",
        modelID: "glm-5.2",
      }],
      attention: {
        visibleOpenIncidentCount: 0,
        failedLaneCount: 0,
        activeAttentionCount: 1,
        userActionRequiredCount: 0,
        retryingCount: 1,
      },
    }), config)

    expect(value.attentionItems[0]).toMatchObject({
      kind: "PROVIDER_RETRY",
      retryLayer: "PROVIDER",
      retryAttempt: 2,
      httpStatus: 503,
      providerID: "zai",
    })
    expect(() => parseMotryxControlSnapshot(snapshot({ attentionItems: [{ kind: "RETRY_SOMETIME" }] }), config))
      .toThrow("snapshot.attentionItems[0].kind is invalid")
  })

  test("parses session-scoped runtime health warnings without changing workflow truth", () => {
    expect(parseMotryxRuntimeHealthWarnings([{
      warningID: "runtime_health_warning_1",
      kind: "ROUTE_HEALTH_UNCONFIRMED",
      scope: "SESSION",
      components: ["OPEN_CODE", "SIDECAR"],
      firstObservedAt: "2026-08-17T00:00:00.000Z",
      lastObservedAt: "2026-08-17T00:00:30.000Z",
      safeSummary: "Runtime health could not be confirmed.",
      httpStatus: 503,
      dismissible: true,
    }])).toEqual([expect.objectContaining({
      warningID: "runtime_health_warning_1",
      components: ["OPEN_CODE", "SIDECAR"],
      httpStatus: 503,
    })])
    expect(() => parseMotryxRuntimeHealthWarnings([{
      warningID: "bad",
      kind: "ROUTE_HEALTH_UNCONFIRMED",
      scope: "SESSION",
      components: ["UNKNOWN"],
      firstObservedAt: "2026-08-17T00:00:00.000Z",
      lastObservedAt: "2026-08-17T00:00:30.000Z",
      safeSummary: "bad",
      dismissible: true,
    }])).toThrow("runtimeWarnings[0].components contains an invalid component")
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

  test("persists incident dismissal against the exact projection route", async () => {
    let request: Request | undefined
    const proof = parseMotryxControlSnapshot(snapshot(), config)
    const result = await dismissMotryxIncident(config, { incidentID: "incident_1", snapshot: proof }, {
      fetcher: async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          schemaVersion: 11,
          incidentID: "incident_1",
          status: "OPEN",
          presentationState: "DISMISSED",
          dismissedAt: 1_786_510_000_000,
        })
      },
    })
    expect(result).toMatchObject({ incidentID: "incident_1", presentationState: "DISMISSED" })
    expect(request?.method).toBe("POST")
    expect(new URL(request!.url).pathname).toBe("/ic/incidents/incident_1/dismiss")
    expect(request?.headers.get("authorization")).toBe(`Bearer ${config.token}`)
    expect(await request!.json()).toEqual({
      orchestratorSessionID: config.orchestratorSessionID,
      expectedServerGeneration: "server-generation",
      expectedBindingGeneration: 7,
      expectedProjectionRevision: "server-generation:ic:revision",
    })
  })
})

describe("Motryx typed Orchestrator sessions", () => {
  const sessions = () => ({
    schemaVersion: 11,
    projectID,
    status: "ROUTABLE",
    current: {
      sessionID: "ses_orchestrator",
      serverGeneration: "server-generation",
      bindingGeneration: 7,
      ownerRunID: "run_public",
    },
    transition: null,
    sessions: [
      {
        sessionID: "ses_orchestrator",
        title: "Current",
        lastRoutedAt: "2026-07-19T00:00:00.000Z",
        state: "CURRENT",
      },
      {
        sessionID: "ses_previous",
        title: "Previous",
        lastRoutedAt: "2026-07-18T00:00:00.000Z",
        state: "RESUMABLE",
      },
    ],
  })

  test("parses a current route and fails closed on inconsistent session state", () => {
    expect(parseMotryxSessionList(sessions(), config)).toMatchObject({
      status: "ROUTABLE",
      current: { sessionID: "ses_orchestrator", bindingGeneration: 7 },
      sessions: [{ state: "CURRENT" }, { state: "RESUMABLE" }],
    })
    expect(() => parseMotryxSessionList({ ...sessions(), projectID: "/tmp/other" }, config)).toThrow(
      "sessions.projectID does not match",
    )
    expect(() => parseMotryxSessionList({ ...sessions(), current: null }, config)).toThrow(
      "sessions.current is required",
    )
    expect(() => parseMotryxSessionList({ ...sessions(), sessions: [] }, config)).toThrow(
      "current item does not match",
    )
  })

  test("uses the authenticated control API for list and exact CAS switch", async () => {
    const requests: Request[] = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      if (requests.length === 1) return Response.json(sessions())
      return Response.json({
        ...sessions(),
        current: {
          sessionID: "ses_previous",
          serverGeneration: "server-generation",
          bindingGeneration: 8,
          ownerRunID: "run_previous",
        },
        sessions: [
          { ...sessions().sessions[1], state: "CURRENT" },
          { ...sessions().sessions[0], state: "RESUMABLE" },
        ],
      })
    }
    const listed = await fetchMotryxSessions(config, { fetcher })
    await switchMotryxSession(config, {
      targetSessionID: "ses_previous",
      expected: listed.current!,
    }, { fetcher })

    expect(new URL(requests[0]!.url).pathname).toBe("/ic/sessions")
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${config.token}`)
    expect(new URL(requests[1]!.url).pathname).toBe("/ic/sessions/switch")
    expect(requests[1]!.method).toBe("POST")
    expect(await requests[1]!.json()).toEqual({
      targetSessionID: "ses_previous",
      expected: {
        serverGeneration: "server-generation",
        currentSessionID: "ses_orchestrator",
        bindingGeneration: 7,
        ownerRunID: "run_public",
      },
    })
  })
})
