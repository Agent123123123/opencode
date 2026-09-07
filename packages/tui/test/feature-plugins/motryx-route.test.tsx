/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiDialogPromptProps, TuiDialogSelectProps, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import path from "node:path"
import { MotryxRoute, type MotryxRouteActions } from "../../src/feature-plugins/motryx/route"
import {
  parseMotryxControlSnapshot,
  type MotryxControlConfig,
  type MotryxControlSnapshot,
} from "../../src/feature-plugins/motryx/control"
import type { SessionSurfaceProps } from "../../src/routes/session"
import { createTuiPluginApi } from "../fixture/tui-plugin"

test("Motryx plugin route composes the standard session surface with the Flow/Inspect sidecar", async () => {
  const projectID = path.resolve("/tmp/motryx-route-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:19999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_route",
  }
  const lifecycle = new AbortController()
  const base = createTuiPluginApi()
  const api = {
    ...base,
    lifecycle: {
      signal: lifecycle.signal,
      onDispose: () => () => {},
    },
  } as unknown as TuiPluginApi
  const now = "2026-07-19T00:00:00.000Z"
  const checkerDetail =
    "CHECKER_DETAIL_INSPECT_ONLY registered snapshot evidence implementation showing recommended_skills"
  const snapshot: MotryxControlSnapshot = {
    schemaVersion: 10,
    projectID,
    orchestratorSessionID: config.orchestratorSessionID,
    projectionRevision: "server-generation:ic:route",
    runtimeCellEpoch: "host-generation:sidecar-generation",
    runtimeOverlayRevision: 1,
    route: {
      state: "ROUTABLE",
      serverGeneration: "server-generation",
      sidecarGeneration: "server-generation",
      bindingGeneration: 4,
      reconciledThrough: { sessionID: config.orchestratorSessionID, seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID: config.orchestratorSessionID,
      runtimeID: "runtime",
      bindingState: "ACTIVE",
      bindingGeneration: 4,
      ownerRunID: "run",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    workflow: { id: "wf", status: "ACTIVE", goal: "Ship the v1.18.3 migration" },
    capacity: {
      maxConcurrentLanes: 0,
      activeLaneIDs: [],
      activeCount: 0,
      available: null,
      capacityReached: false,
      readyLaneIDs: [],
    },
    lanes: Array.from({ length: 20 }, (_, index) => ({
      id: `lane_tui_${index + 1}`,
      name: index === 0 ? "TUI migration" : index === 19 ? "Final lane 20" : `Migration lane ${index + 1}`,
      status: index === 0 ? "DONE" : "OPEN",
      stableStatus: index === 0 ? "DONE" : "OPEN",
      displayStatus: index === 0 ? "DONE" : "WORKING",
      updatedAt: now,
      reopenCount: 0,
      repairCycle: 0,
      dependsOnLaneIDs: index === 1 ? ["lane_tui_1"] : [],
      lastCheckResult: index === 0 ? checkerDetail : undefined,
      coordinatorRuntimeReadiness: "unmaterialized",
      checkerRuntimeReadiness: "unmaterialized",
    })),
    agents: [],
    artifacts: [],
    resourceBlocks: [],
    incidents: [],
    functionSlots: [],
    runtimeExecutions: [],
    executionHistory: [],
    attentionItems: [],
    runtimeWarnings: [{
      warningID: "runtime_health_warning_route",
      kind: "ROUTE_HEALTH_UNCONFIRMED",
      scope: "SESSION",
      components: ["OPEN_CODE"],
      firstObservedAt: "2026-08-17T00:00:00.000Z",
      lastObservedAt: "2026-08-17T00:00:30.000Z",
      safeSummary: "OpenCode health could not be confirmed.",
      dismissible: true,
    }],
    attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
    diagnostics: [],
  }
  let currentSnapshot: MotryxControlSnapshot = snapshot
  let workflowResponse: "valid" | "schema-error" = "valid"
  const events = new ReadableStream<Uint8Array>()
  let workflowCalls = 0
  let actions: MotryxRouteActions | undefined
  let surfaceProps: SessionSurfaceProps | undefined
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") {
            workflowCalls += 1
            if (workflowResponse === "schema-error") return Response.json({ schemaVersion: 1 })
            return Response.json(currentSnapshot)
          }
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={(surface) => {
          surfaceProps = surface
          return (
            <box flexGrow={1} minHeight={0} flexDirection="column">
              <text>STANDARD OPENCODE SESSION</text>
              <text>{surface.sessionID}</text>
              <text>Migrate the TUI with the full conversation and prompt</text>
              <text>PERMISSION QUESTION</text>
              <text>COMPOSER STATUS</text>
              <text>{surface.interaction}</text>
            </box>
          )
        }}
        onActionsAvailable={(next) => (actions = next)}
      />
    ),
    { width: 120, height: 30 },
  )

  try {
    const deadline = Date.now() + 2_000
    let frame = ""
    while (Date.now() < deadline) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("TUI migration") && frame.includes("STANDARD OPENCODE SESSION")) break
      await Bun.sleep(10)
    }
    expect(workflowCalls).toBe(1)
    expect(frame).toContain("MotryX")
    expect(frame).toContain("Ship the v1.18.3 migration / Orchestrator")
    expect(frame).not.toContain("conversation + sidecar")
    expect(frame).not.toContain("CONVERSATION")
    expect(frame).not.toContain("ROUTABLE")
    expect(frame).toContain("Ship the v1.18.3 migration")
    expect(frame).toContain("Runtime health could not be confirmed")
    expect(frame).toContain("Existing work was not interrupted")
    await clickFrameText(app, frame, "[×]")
    frame = await renderUntil(app, (value) => !value.includes("Runtime health could not be confirmed"))
    expect(frame).toContain("TUI migration")
    expect(frame).toContain("DONE")
    expect(frame).not.toContain("CHECKER_DETAIL_INSPECT_ONLY")
    expect(frame).toContain("Migrate the TUI")
    expect(frame).toContain("interactive")
    expect(frame).not.toContain("DEBUG")
    expect(frame).not.toContain("2 Coordinator")
    expect(frame).not.toContain("/motryx flow")
    expect(frame).not.toContain("lane details")
    expect(surfaceProps?.showIdleFooter).toBe(false)
    expect(surfaceProps?.showNativeSidebar).toBe(false)
    expect(surfaceProps?.showExitEpilogue).toBe(false)
    expect(surfaceProps?.historyMutation).toBe("disabled")

    await clickFrameText(app, frame, "TUI migration")
    frame = await renderUntil(app, (value) => value.includes("[INSPECT]"))
    expect(frame).toContain("CHECKER_DETAIL_INSPECT_ONLY")
    expect(frame.replace(/[^A-Za-z_]/g, "")).toContain(checkerDetail.replace(/[^A-Za-z_]/g, ""))
    expect(frame).toContain("STANDARD OPENCODE SESSION")
    expect(frame).toContain("ses_route")
    await clickFrameText(app, frame, "FLOW")
    frame = await renderUntil(app, (value) => value.includes("[FLOW]"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")

    actions!.moveLane(1)
    frame = await renderUntil(app, (value) => value.includes("Migration lane 2"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")
    expect(frame).toContain("ses_route")
    expect(frame).toContain("INSPECT")
    expect(frame).toContain("TUI migration")
    expect(frame).not.toContain("lane_tui_1")
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("Migration lane 2"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")

    actions!.showFlow()
    await app.renderOnce()
    await app.waitFor(() => findScrollBoxes(app.renderer.root).some((box) => box.scrollHeight > box.viewport.height))
    const workflowScroll = findScrollBoxes(app.renderer.root).find((box) => box.scrollHeight > box.viewport.height)
    expect(workflowScroll).toBeDefined()
    const maxScrollTop = workflowScroll!.scrollHeight - workflowScroll!.viewport.height
    expect(maxScrollTop).toBeGreaterThan(0)
    workflowScroll!.scrollTo(maxScrollTop)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Final lane 20")

    app.resize(39, 24)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("STANDARD OPENCODE SESSION")

    app.resize(80, 24)
    await app.renderOnce()
    const restoredFrame = app.captureCharFrame()
    expect(restoredFrame).toContain("STANDARD OPENCODE SESSION")

    for (const [width, height] of [
      [40, 12],
      [60, 16],
      [80, 16],
      [80, 24],
      [99, 24],
      [100, 24],
      [120, 32],
      [160, 50],
    ]) {
      app.resize(width, height)
      await app.renderOnce()
      const responsiveFrame = app.captureCharFrame()
      expect(responsiveFrame).toContain("MotryX")
      expect(responsiveFrame).not.toContain("CONVERSATION")
      expect(responsiveFrame).toContain("STANDARD OPENCODE")
      expect(responsiveFrame).toContain("PERMISSION QUESTION")
      expect(responsiveFrame).toContain("COMPOSER STATUS")
      if (width === 40 && height === 12) {
        expect(responsiveFrame).toContain("[FLOW] INSPECT INCIDENTS")
        expect(responsiveFrame).not.toContain("INSPECTINCIDENTS")
      }
    }

    app.resize(80, 24)
    await app.renderOnce()
    const selectionFrame = app.captureCharFrame()

    const transcriptLine = selectionFrame.split("\n").findIndex((line) => line.includes("Migrate the TUI"))
    const transcriptColumn = selectionFrame.split("\n")[transcriptLine]!.indexOf("Migrate the TUI")
    expect(transcriptLine).toBeGreaterThanOrEqual(0)
    expect(transcriptColumn).toBeGreaterThanOrEqual(0)
    await app.mockMouse.drag(transcriptColumn, transcriptLine, transcriptColumn + 7, transcriptLine)
    expect(app.renderer.getSelection()?.getSelectedText()).toContain("Migrate")

    currentSnapshot = {
      ...snapshot,
      workflow: {
        ...snapshot.workflow!,
        goal: "A long workflow goal that must not overlap the empty lane state. ".repeat(20),
      },
      lanes: [],
    }
    app.resize(120, 30)
    actions!.showFlow()
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("No lanes yet."))
    expect(frame).toContain("No lanes yet.")
    expect(frame).not.toContain("Nolanesyet.")
    const longGoalHeader = frame.split("\n")[0] ?? ""
    expect(longGoalHeader).toContain("MotryX")
    expect(longGoalHeader).toContain("Orchestrator")

    currentSnapshot = { ...snapshot, workflow: undefined, lanes: [] }
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("No workflow yet."))
    expect(frame).toContain("Continue the Orchestrator conversation")
    expect(frame).not.toContain("No lanes yet.")

    workflowResponse = "schema-error"
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("SCHEMA ERROR"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")
    expect(frame).toContain("COMPOSER STATUS")
    expect(frame).not.toContain(config.token)
    expect(frame).not.toContain("channel.db")
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

test("Motryx runtime error card can be dismissed without resolving the incident", async () => {
  const projectID = path.resolve("/tmp/motryx-route-incident-project")
  const sessionID = "ses_route_incident"
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:27999",
    token: "control-token",
    projectID,
    orchestratorSessionID: sessionID,
  }
  const lifecycle = new AbortController()
  const base = createTuiPluginApi()
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
  } as unknown as TuiPluginApi
  const incident = {
    incidentID: "incident_route_1",
    scopeKind: "SESSION" as const,
    role: "orchestrator",
    failedPhase: "ORCHESTRATOR_TURN",
    failureKind: "transport",
    status: "OPEN" as const,
    presentationState: "VISIBLE" as const,
    safeSummary: "The provider did not send HTTP response headers before the transport deadline.",
    instanceID: "inst_orchestrator",
    sessionID,
    providerID: "zai",
    modelID: "glm-5.2",
    transportKind: "timeout",
    transportCode: "UND_ERR_HEADERS_TIMEOUT",
    retryable: false,
    retryExhausted: true,
    attemptCount: 3,
    occurrenceCount: 1,
    openedAt: 1_786_510_000_000,
    lastSeenAt: 1_786_510_000_000,
  }
  let snapshot = {
    ...debugRouteSnapshot(projectID, sessionID),
    workflow: undefined,
    lanes: [],
    incidents: [incident],
    attentionItems: [{
      attentionID: `incident:${incident.incidentID}`,
      kind: "FINAL_FAILURE" as const,
      severity: "ERROR" as const,
      scopeKind: "SESSION" as const,
      role: "orchestrator",
      inputID: "input_orchestrator_failure",
      summaryID: "summary_orchestrator_failure",
      incidentID: incident.incidentID,
      summary: incident.safeSummary,
      reasonCode: "retry_exhausted_transport",
      nextAction: "repair_and_retry",
      actionRequired: true,
      dismissible: true,
      presentationState: "VISIBLE" as const,
      createdAt: incident.openedAt,
      failureKind: "transport",
      transportKind: incident.transportKind,
      transportCode: incident.transportCode,
      providerID: incident.providerID,
      modelID: incident.modelID,
    }],
    attention: { visibleOpenIncidentCount: 1, failedLaneCount: 0, activeAttentionCount: 1, userActionRequiredCount: 1, retryingCount: 0 },
  } as MotryxControlSnapshot
  let dismissals = 0
  const events = new ReadableStream<Uint8Array>()
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") return Response.json(snapshot)
          if (url.pathname === "/ic/incidents/incident_route_1/dismiss") {
            dismissals += 1
            snapshot = {
              ...snapshot,
              incidents: [{ ...incident, presentationState: "DISMISSED" }],
              attentionItems: snapshot.attentionItems.map((item) => ({ ...item, presentationState: "DISMISSED" as const })),
              attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
            }
            return Response.json({
              schemaVersion: 10,
              incidentID: incident.incidentID,
              status: "OPEN",
              presentationState: "DISMISSED",
              dismissedAt: 1_786_510_000_001,
            })
          }
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={() => (
          <box height={6} flexShrink={0} flexDirection="column">
            <text>STANDARD OPENCODE SESSION</text>
            <text>Conversation history</text>
            <text>Permission question</text>
            <text>COMPOSER DRAFT</text>
            <text>Orchestrator model</text>
            <text>COMPOSER BOTTOM</text>
          </box>
        )}
        onActionsAvailable={() => {}}
      />
    ),
    { width: 100, height: 24 },
  )
  try {
    let frame = await renderUntil(app, (value) => value.includes(incident.safeSummary))
    expect(frame).toContain("Runtime error · Orchestrator")
    expect(frame).toContain("transport UND_ERR_HEADERS_TIMEOUT")
    expect(frame).toContain("kind timeout")
    expect(frame).toContain("zai/glm-5.2")
    expect(frame).toContain("No workflow yet.")
    expect(frame).toContain("! 1")
    expect(frame).not.toContain("Final failure · Orchestrator")
    app.resize(40, 12)
    frame = await renderUntil(app, (value) => value.includes("COMPOSER BOTTOM"))
    expect(frame).toContain("transport · Orchestrator")
    expect(frame).toContain("COMPOSER DRAFT")
    expect(frame.split("\n").findIndex((line) => line.includes("COMPOSER BOTTOM")))
      .toBeLessThan(frame.split("\n").findIndex((line) => line.includes("[FLOW]")))
    expect(dismissals).toBe(0)
    await clickFrameText(app, frame, "[×]")
    frame = await renderUntil(app, (value) => !value.includes(incident.safeSummary))
    expect(frame).not.toContain("Runtime error · Orchestrator")
    expect(dismissals).toBe(1)
    expect(snapshot.incidents[0]).toMatchObject({ status: "OPEN", presentationState: "DISMISSED" })
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

test("Motryx v8 separates runtime retry from stable reconciliation attention", async () => {
  const projectID = path.resolve("/tmp/motryx-route-attention-project")
  const sessionID = "ses_route_attention"
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:28999",
    token: "control-token",
    projectID,
    orchestratorSessionID: sessionID,
  }
  const lifecycle = new AbortController()
  const base = createTuiPluginApi()
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
  } as unknown as TuiPluginApi
  const attentionID = "attention_runtime_lifecycle"
  const retryAt = Date.now() + 60_000
  const retryAttention = {
    attentionID,
    kind: "PROVIDER_RETRY" as const,
    severity: "WARNING" as const,
    scopeKind: "SESSION" as const,
    role: "orchestrator",
    claimID: "claim_session_retry",
    inputID: "input_session_retry_2",
    summary: "OpenCode is retrying the current provider request inside this Turn.",
    reasonCode: "transport",
    nextAction: "wait_for_retry",
    actionRequired: false,
    dismissible: true,
    presentationState: "VISIBLE" as const,
    createdAt: Date.now(),
    retryLayer: "PROVIDER" as const,
    retryAttempt: 1,
    retryLimit: 2,
    retryNotBefore: retryAt,
    failureKind: "transport",
    transportKind: "network",
    transportCode: "ECONNRESET",
    providerID: "zai",
    modelID: "glm-5.2",
  }
  let currentSnapshot = {
    ...debugRouteSnapshot(projectID, sessionID),
    projectionRevision: "server:attention-retry",
    workflow: undefined,
    lanes: [],
    agents: [],
    attentionItems: [retryAttention],
    attention: {
      visibleOpenIncidentCount: 0,
      failedLaneCount: 0,
      activeAttentionCount: 1,
      userActionRequiredCount: 0,
      retryingCount: 1,
    },
  } as MotryxControlSnapshot
  let actions: MotryxRouteActions | undefined
  const events = new ReadableStream<Uint8Array>()
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") return Response.json(currentSnapshot)
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={() => <text>STANDARD OPENCODE SESSION</text>}
        onActionsAvailable={(next) => (actions = next)}
      />
    ),
    { width: 120, height: 32 },
  )

  try {
    let frame = await renderUntil(app, (value) => value.includes("OpenCode is retrying"))
    expect(frame).toContain("Provider retry · Orchestrator")
    expect(frame).toContain("provider retry 1/2")
    expect(frame).toContain("next wait_for_retry")
    expect(frame).toContain("No workflow yet.")

    await clickFrameText(app, frame, "[×]")
    frame = await renderUntil(app, (value) => !value.includes("OpenCode is retrying"))
    expect(frame).not.toContain("OpenCode is retrying")
    await actions!.refresh()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("OpenCode is retrying")

    actions!.showIncidents()
    frame = await renderUntil(app, (value) => value.includes("locally"))
    expect(frame).toContain("OpenCode is retrying")
    expect(frame).toContain("hidden")
    expect(frame).toContain("locally")

    currentSnapshot = {
      ...currentSnapshot,
      projectionRevision: "server:attention-cleared",
      attentionItems: [],
      attention: {
        visibleOpenIncidentCount: 0,
        failedLaneCount: 0,
        activeAttentionCount: 0,
        userActionRequiredCount: 0,
        retryingCount: 0,
      },
    }
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("No active runtime attention."))
    expect(frame).not.toContain("locally")

    const unknownAttention = {
      ...retryAttention,
      attentionID: "attention_outcome_unknown",
      kind: "OUTCOME_UNKNOWN" as const,
      severity: "ERROR" as const,
      summary: "The previous input may have been admitted; its outcome must be reconciled before retry.",
      reasonCode: "delivery_ambiguous_after_5_submissions",
      nextAction: "reconcile_outcome",
      actionRequired: true,
      retryLayer: undefined,
      retryAttempt: undefined,
      retryLimit: undefined,
      retryNotBefore: undefined,
      httpStatus: 503,
      transportKind: "http-sse",
      transportCode: "UND_ERR_HEADERS_TIMEOUT",
    }
    currentSnapshot = {
      ...currentSnapshot,
      projectionRevision: "server:attention-unknown",
      attentionItems: [unknownAttention],
      attention: {
        visibleOpenIncidentCount: 0,
        failedLaneCount: 0,
        activeAttentionCount: 1,
        userActionRequiredCount: 1,
        retryingCount: 0,
      },
    }
    expect(() => parseMotryxControlSnapshot(currentSnapshot, config)).not.toThrow()
    actions!.showFlow()
    await app.renderOnce()
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("previous input may have been admitted"))
    expect(frame).toContain("Outcome unknown · Orchestrator")
    expect(frame).toContain("HTTP 503")
    expect(frame).toContain("transport UND_ERR_HEADERS_TIMEOUT")
    expect(frame).toContain("next reconcile_outcome")

    const laneSnapshot = debugRouteSnapshot(projectID, sessionID)
    const waitingAttention = {
      ...unknownAttention,
      attentionID: "attention_waiting_reconciliation",
      kind: "WAITING_RECONCILIATION" as const,
      scopeKind: "LANE" as const,
      role: "coordinator",
      laneID: "lane_debug",
      inputID: "input_lane_reconciliation",
      recoveryDecisionID: "decision_lane_reconciliation",
      summary: "Lane decision is waiting for authoritative effect reconciliation.",
      reasonCode: "effect_unknown",
    }
    currentSnapshot = {
      ...laneSnapshot,
      projectionRevision: "server:attention-reconciliation",
      lanes: laneSnapshot.lanes.map((lane) => ({
        ...lane,
        status: "PENDING",
        stableStatus: "PENDING",
        displayStatus: "PENDING",
      })),
      runtimeExecutions: [],
      executionHistory: [{
        summaryID: "summary_lane_reconciliation",
        evidenceKey: "evidence_lane_reconciliation",
        origin: "FRAMEWORK",
        productSessionID: sessionID,
        ownerKind: "FUNCTION_SLOT",
        ownerID: "slot_debug_coordinator",
        ownerGeneration: 1,
        workflowID: "workflow",
        laneID: "lane_debug",
        role: "coordinator",
        checkpointKind: "LANE",
        checkpointID: "lane_debug",
        sessionID: "ses_coordinator",
        inputID: "msg_lane_reconciliation",
        turnID: "turn_lane_reconciliation",
        terminalKind: "FAILED",
        terminalEventID: "event_lane_reconciliation",
        terminalProofRef: "proof_lane_reconciliation",
        terminalAt: Date.now() - 1_000,
        failureKind: "provider_internal",
        safeSummary: "Provider returned an ambiguous response after the tool effect.",
        createdAt: Date.now() - 4_000,
      }],
      attentionItems: [waitingAttention],
      attention: {
        visibleOpenIncidentCount: 0,
        failedLaneCount: 0,
        activeAttentionCount: 1,
        userActionRequiredCount: 1,
        retryingCount: 0,
      },
    } as MotryxControlSnapshot
    await actions!.refresh()
    app.resize(160, 60)
    actions!.showInspect()
    frame = await renderUntil(app, (value) => value.includes("Waiting for reconciliation"))
    expect(frame).toContain("next action")
    expect(frame).toContain("reconcile_outcome")
    expect(frame).toContain("effect_unknown")
    expect(frame).toContain("coordinator:FAILED")
    expect(frame).toContain("provider_internal")
    expect(frame).toContain("input msg_lane_reconciliation")
    expect(frame).not.toContain("repair runtime/provider, then retry_failed_lane")
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

function findScrollBoxes(root: Renderable): ScrollBoxRenderable[] {
  return [
    ...(root instanceof ScrollBoxRenderable ? [root] : []),
    ...root.getChildren().flatMap((child) => findScrollBoxes(child)),
  ]
}

test("/sessions switches the exact Motryx Orchestrator and rebinds conversation plus projection", async () => {
  const projectID = path.resolve("/tmp/motryx-route-switch-project")
  const sourceID = "ses_switch_source"
  const targetID = "ses_switch_target"
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:25999",
    token: "control-token",
    projectID,
    orchestratorSessionID: sourceID,
  }
  const lifecycle = new AbortController()
  let dialogRender: (() => unknown) | undefined
  let dialog: TuiDialogSelectProps<string> | undefined
  let renameDialog: TuiDialogPromptProps | undefined
  const notices: string[] = []
  const requests: Request[] = []
  const updates: Array<{ sessionID: string; title?: string }> = []
  const titles = new Map([
    [sourceID, "Source Orchestrator"],
    [targetID, "Target Orchestrator"],
  ])
  let dialogClears = 0
  const base = createTuiPluginApi({
    client: {
      v2: {
        session: {
          async get(input: { sessionID: string }) {
            return {
              data: {
                data: {
                  id: input.sessionID,
                  agent: "orchestrator",
                  title: titles.get(input.sessionID),
                  location: { directory: projectID },
                },
              },
            }
          },
          async update(input: { sessionID: string; title?: string }) {
            updates.push(input)
            if (input.title === "Rejected rename") throw new Error("rename rejected")
            if (input.title) titles.set(input.sessionID, input.title)
            if (input.title === "Recovered rename") throw new Error("response lost")
            return { data: { data: { id: input.sessionID, title: input.title } } }
          },
        },
      },
    } as TuiPluginApi["client"],
  })
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
    ui: {
      ...base.ui,
      DialogSelect(props: TuiDialogSelectProps<string>) {
        dialog = props
        return undefined as never
      },
      DialogPrompt(props: TuiDialogPromptProps) {
        renameDialog = props
        return undefined as never
      },
      dialog: {
        ...base.ui.dialog,
        clear() {
          dialogClears += 1
        },
        replace(render: () => unknown) {
          dialogRender = render
        },
      },
      toast(input: { message: string }) {
        notices.push(input.message)
      },
    },
  } as unknown as TuiPluginApi
  const now = "2026-07-19T00:00:00.000Z"
  const routeSnapshot = (sessionID: string, bindingGeneration: number): MotryxControlSnapshot => ({
    schemaVersion: 10,
    projectID,
    orchestratorSessionID: sessionID,
    projectionRevision: `server-generation:ic:${sessionID}`,
    runtimeCellEpoch: `host-generation:sidecar-generation`,
    runtimeOverlayRevision: 1,
    route: {
      state: "ROUTABLE",
      serverGeneration: "server-generation",
      sidecarGeneration: "server-generation",
      bindingGeneration,
      reconciledThrough: { sessionID, seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID: sessionID,
      runtimeID: `runtime_${sessionID}`,
      bindingState: "ACTIVE",
      bindingGeneration,
      ownerRunID: bindingGeneration === 7 ? "run_source" : "run_target",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: now,
    },
    workflow: { id: `wf_${sessionID}`, status: "ACTIVE", goal: `Goal ${sessionID}` },
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
    functionSlots: [],
    runtimeExecutions: [],
    executionHistory: [],
    attentionItems: [],
    runtimeWarnings: [],
    attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
    diagnostics: [],
  })
  const sessionList = (currentID: string, bindingGeneration: number) => ({
    schemaVersion: 10,
    projectID,
    status: "ROUTABLE",
    current: {
      sessionID: currentID,
      serverGeneration: "server-generation",
      bindingGeneration,
      ownerRunID: currentID === sourceID ? "run_source" : "run_target",
    },
    transition: null,
    sessions: currentID === sourceID
      ? [
          { sessionID: sourceID, title: titles.get(sourceID)!, lastRoutedAt: now, state: "CURRENT" },
          { sessionID: targetID, title: titles.get(targetID)!, lastRoutedAt: now, state: "RESUMABLE" },
        ]
      : [
          { sessionID: targetID, title: titles.get(targetID)!, lastRoutedAt: now, state: "CURRENT" },
          { sessionID: sourceID, title: titles.get(sourceID)!, lastRoutedAt: now, state: "RESUMABLE" },
        ],
  })
  let actions: MotryxRouteActions | undefined
  let surface: SessionSurfaceProps | undefined
  let routedID = sourceID
  let bindingGeneration = 7
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input, init) => {
          const request = new Request(input, init)
          requests.push(request.clone())
          const url = new URL(request.url)
          if (url.pathname === "/ic/sessions" && request.method === "GET") {
            return Response.json(sessionList(routedID, bindingGeneration))
          }
          if (url.pathname === "/ic/sessions/switch") {
            const body = (await request.json()) as { targetSessionID: string }
            routedID = body.targetSessionID
            bindingGeneration += 1
            return Response.json(sessionList(routedID, bindingGeneration))
          }
          if (url.pathname === "/ic/workflow") {
            const sessionID = url.searchParams.get("orchestrator_session_id")!
            return Response.json(routeSnapshot(sessionID, sessionID === sourceID ? 7 : 8))
          }
          return new Response(new ReadableStream<Uint8Array>(), {
            headers: { "content-type": "text/event-stream" },
          })
        }}
        sessionSurface={(props) => {
          surface = props
          return <text>SWITCHED SURFACE {props.sessionID}</text>
        }}
        onActionsAvailable={(next) => (actions = next)}
      />
    ),
    { width: 100, height: 24 },
  )

  try {
    await renderUntil(app, (frame) => frame.includes(`SWITCHED SURFACE ${sourceID}`))
    await actions!.showSessions()
    expect(dialogRender).toBeDefined()
    dialogRender?.()
    expect(dialog?.options.map((item) => [item.value, item.disabled])).toEqual([
      [sourceID, false],
      [targetID, false],
    ])
    dialog?.onSelect?.(dialog.options[1]!)
    const frame = await renderUntil(app, (value) => value.includes(`SWITCHED SURFACE ${targetID}`))
    expect(frame).toContain(`Goal ${targetID}`)
    expect(surface?.sessionID).toBe(targetID)
    expect(notices).toContain("Switched to Target Orchestrator")
    const request = requests.find((item) => new URL(item.url).pathname === "/ic/sessions/switch")
    expect(request).toBeDefined()
    expect(await request!.json()).toEqual({
      targetSessionID: targetID,
      expected: {
        serverGeneration: "server-generation",
        currentSessionID: sourceID,
        bindingGeneration: 7,
        ownerRunID: "run_source",
      },
    })

    await actions!.rename()
    dialogRender?.()
    expect(renameDialog?.value).toBe("Target Orchestrator")
    renameDialog?.onConfirm?.("  Renamed Target  ")
    await renderUntil(app, () => updates.length === 1)
    expect(updates).toEqual([{ sessionID: targetID, title: "Renamed Target" }])
    expect(notices).toContain("Renamed Motryx Orchestrator to Renamed Target")
    await actions!.showSessions()
    dialogRender?.()
    expect(dialog?.options.find((option) => option.value === targetID)?.title).toBe("Renamed Target")

    await actions!.rename()
    dialogRender?.()
    renameDialog?.onConfirm?.("Renamed Target")
    expect(updates).toHaveLength(1)
    expect(notices).toContain("Motryx Orchestrator name is unchanged.")

    await actions!.rename()
    dialogRender?.()
    renameDialog?.onConfirm?.("   ")
    expect(updates).toHaveLength(1)
    expect(notices).toContain("Session name is required.")

    await actions!.rename()
    dialogRender?.()
    renameDialog?.onConfirm?.("x".repeat(101))
    expect(updates).toHaveLength(1)
    expect(notices).toContain("Session name must be 100 characters or fewer.")

    await actions!.rename()
    dialogRender?.()
    const clearsBeforeFailure = dialogClears
    renameDialog?.onConfirm?.("Rejected rename")
    await renderUntil(app, () => notices.includes("rename rejected"))
    expect(updates.at(-1)).toEqual({ sessionID: targetID, title: "Rejected rename" })
    expect(dialogClears).toBe(clearsBeforeFailure)
    expect(notices).not.toContain("Renamed Motryx Orchestrator to Rejected rename")

    await actions!.rename()
    dialogRender?.()
    renameDialog?.onConfirm?.("Recovered rename")
    await renderUntil(app, () => notices.includes("Renamed Motryx Orchestrator to Recovered rename"))
    expect(updates.at(-1)).toEqual({ sessionID: targetID, title: "Recovered rename" })

    await actions!.rename()
    dialogRender?.()
    const staleRename = renameDialog
    await actions!.showSessions()
    dialogRender?.()
    const source = dialog?.options.find((option) => option.value === sourceID)
    expect(source).toBeDefined()
    dialog?.onSelect?.(source!)
    await renderUntil(app, (value) => value.includes(`SWITCHED SURFACE ${sourceID}`))
    staleRename?.onConfirm?.("Stale target")
    expect(updates).toHaveLength(3)
    expect(notices).toContain("Motryx route changed while rename was open. Run /rename again for the current Orchestrator.")

    await actions!.rename()
    dialogRender?.()
    const disposedRename = renameDialog
    lifecycle.abort()
    disposedRename?.onConfirm?.("Disposed target")
    expect(updates).toHaveLength(3)
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

test("Motryx route shows a branded loading page until the first exact projection resolves", async () => {
  const projectID = path.resolve("/tmp/motryx-route-loading-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:24999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_loading",
  }
  const lifecycle = new AbortController()
  const base = createTuiPluginApi()
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
  } as unknown as TuiPluginApi
  let resolveWorkflow!: (response: Response) => void
  const workflow = new Promise<Response>((resolve) => (resolveWorkflow = resolve))
  const events = new ReadableStream<Uint8Array>()
  let surfaceMounted = false
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") return workflow
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={() => {
          surfaceMounted = true
          return <text>LOADED CONVERSATION</text>
        }}
        onActionsAvailable={() => {}}
      />
    ),
    { width: 80, height: 24 },
  )

  try {
    await app.renderOnce()
    let frame = app.captureCharFrame()
    expect(frame).toContain("MotryX")
    expect(frame).toContain("███▄        ▄███")
    expect(frame).toContain("████ █▄  ▄█ ████")
    expect(frame).toContain("Connecting conversation and workflow…")
    expect(frame).toContain("CONNECTING")
    expect(frame).not.toContain("LOADED CONVERSATION")
    expect(surfaceMounted).toBe(false)

    resolveWorkflow(Response.json(debugRouteSnapshot(projectID, config.orchestratorSessionID)))
    frame = await renderUntil(app, (value) => value.includes("LOADED CONVERSATION"))
    expect(frame).toContain("Orchestrator")
    expect(frame).not.toContain("CONNECTING")
    expect(surfaceMounted).toBe(true)
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

test("debug targets require exact OpenCode readback and reset on generation change", async () => {
  const projectID = path.resolve("/tmp/motryx-route-debug-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:29999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_orchestrator",
  }
  const lifecycle = new AbortController()
  const exactReads: string[] = []
  const renames: Array<{ sessionID: string; title?: string }> = []
  let renameRender: (() => unknown) | undefined
  let renameDialog: TuiDialogPromptProps | undefined
  const base = createTuiPluginApi({
    client: {
      v2: {
        session: {
          async get(input: { sessionID: string }) {
            exactReads.push(input.sessionID)
            return {
              data: {
                data: {
                  id: input.sessionID,
                  agent: input.sessionID === config.orchestratorSessionID ? "orchestrator" : "coordinator",
                  title: input.sessionID === config.orchestratorSessionID ? "Debug Orchestrator" : "Coordinator",
                  location: { directory: projectID },
                },
              },
            }
          },
          async update(input: { sessionID: string; title?: string }) {
            renames.push(input)
            return { data: { data: { id: input.sessionID, title: input.title } } }
          },
        },
      },
    } as TuiPluginApi["client"],
  })
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
    ui: {
      ...base.ui,
      DialogPrompt(props: TuiDialogPromptProps) {
        renameDialog = props
        return undefined as never
      },
      dialog: {
        ...base.ui.dialog,
        replace(render: () => unknown) {
          renameRender = render
        },
      },
      toast: () => {},
    },
  } as unknown as TuiPluginApi
  let snapshot = debugRouteSnapshot(projectID, config.orchestratorSessionID)
  let actions: MotryxRouteActions | undefined
  let debugSurfaceProps: SessionSurfaceProps | undefined
  const events = new ReadableStream<Uint8Array>()
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        debugView
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") return Response.json(snapshot)
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={(surface) => {
          debugSurfaceProps = surface
          return (
            <box flexGrow={1} minHeight={0} flexDirection="column">
              <text>TARGET {surface.sessionID}</text>
              <text>MODE {surface.interaction}</text>
            </box>
          )
        }}
        onActionsAvailable={(next) => (actions = next)}
      />
    ),
    { width: 120, height: 30 },
  )

  try {
    let frame = await renderUntil(app, (value) => value.includes("Debug lane"))
    expect(frame).toContain("DEBUG")
    expect(frame).not.toContain("conversation + sidecar")
    expect(frame).not.toContain("ROUTABLE")
    expect(frame).not.toContain("Alt+1/2/3 shortcuts")
    expect(frame).toContain("TARGET ses_orchestrator")
    expect(frame).toContain("MODE interactive")
    expect(frame).not.toContain("Back to Orchestrator")

    actions!.showInspect()
    frame = await renderUntil(app, (value) => value.includes("Open Coordinator"))
    expect(frame).toContain("[Open Coordinator]")
    expect(frame).toContain("[Open Checker]")
    await clickFrameText(app, frame, "Open Coordinator")
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_coordinator"))
    expect(exactReads).toEqual(["ses_coordinator"])
    expect(frame).toContain("MODE read-only")
    expect(frame).toContain("Debug lane / Coordinator")
    expect(frame).toContain("Coordinator · Debug lane")
    expect(frame).toContain("← Back to Orchestrator")

    app.resize(100, 30)
    frame = await renderUntil(app, (value) => value.includes("← Back to Orchestrator"))
    expect(frame).toContain("TARGET ses_coordinator")
    expect(frame).toContain("← Back to Orchestrator")
    expect(frame).toContain("DEBUG")

    app.resize(60, 20)
    frame = await renderUntil(app, (value) => value.includes("← Back to Orchestrator"))
    expect(frame).toContain("TARGET ses_coordinator")
    expect(frame).toContain("← Back to Orchestrator")
    expect(frame).toContain("DBG")

    await clickFrameText(app, frame, "← Back to Orchestrator")
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_orchestrator"))
    expect(frame).toContain("MODE interactive")

    app.resize(120, 30)
    await app.renderOnce()

    actions!.focusCoordinator()
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_coordinator"))
    expect(exactReads).toEqual(["ses_coordinator", "ses_coordinator"])

    await actions!.rename()
    renameRender?.()
    expect(exactReads.at(-1)).toBe(config.orchestratorSessionID)
    expect(renameDialog?.value).toBe("Debug Orchestrator")
    renameDialog?.onConfirm?.("Renamed while viewing worker")
    await renderUntil(app, () => renames.length === 1)
    expect(renames).toEqual([
      { sessionID: config.orchestratorSessionID, title: "Renamed while viewing worker" },
    ])

    for (const [width, height] of [
      [40, 12],
      [60, 16],
      [80, 16],
      [80, 24],
      [99, 24],
      [100, 24],
      [120, 32],
      [160, 50],
    ]) {
      app.resize(width, height)
      frame = await renderUntil(app, (value) => value.includes("← Back to Orchestrator"))
      expect(frame).toContain("TARGET ses_coordinator")
      expect(frame).toContain("← Back to Orchestrator")
      if (width === 80) expect(frame.split("\n")[0]).toContain("DEBUG")
    }

    app.resize(120, 30)
    await app.renderOnce()
    await app.renderOnce()
    await app.waitFor(() => findScrollBoxes(app.renderer.root).some((box) => box.scrollHeight > box.viewport.height))
    const inspectScroll = findScrollBoxes(app.renderer.root).find((box) => box.scrollHeight > box.viewport.height)
    inspectScroll!.scrollTo(inspectScroll!.scrollHeight - inspectScroll!.viewport.height)
    await app.renderOnce()
    frame = app.captureCharFrame()
    expect(frame).toContain("DEBUG identity")
    expect(frame).toContain("coordinator session")
    expect(frame).toContain("ses_coordinator")

    actions!.focusChecker()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("TARGET ses_coordinator")

    debugSurfaceProps!.onSessionUnavailable?.(new Error("Session not found during worker sync"))
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_orchestrator"))
    expect(frame).toContain("MODE interactive")

    actions!.focusCoordinator()
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_coordinator"))
    expect(frame).toContain("MODE read-only")

    snapshot = debugRouteSnapshot(projectID, config.orchestratorSessionID, 8, "server-next")
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_orchestrator"))
    expect(frame).toContain("MODE interactive")
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

async function renderUntil(app: Awaited<ReturnType<typeof testRender>>, predicate: (frame: string) => boolean) {
  const deadline = Date.now() + 2_000
  let frame = ""
  while (Date.now() < deadline) {
    await app.renderOnce()
    frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  return frame
}

async function clickFrameText(app: Awaited<ReturnType<typeof testRender>>, frame: string, label: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf(label)
  expect(x).toBeGreaterThanOrEqual(0)
  await app.mockMouse.click(x, y)
  await app.renderOnce()
}

function debugRouteSnapshot(projectID: string, orchestratorSessionID: string, generation = 7, server = "server") {
  const now = "2026-07-19T00:00:00.000Z"
  return {
    schemaVersion: 10,
    projectID,
    orchestratorSessionID,
    projectionRevision: `${server}:revision`,
    runtimeCellEpoch: `${server}-host:${server}-sidecar`,
    runtimeOverlayRevision: 1,
    route: {
      state: "ROUTABLE",
      serverGeneration: server,
      sidecarGeneration: server,
      bindingGeneration: generation,
      reconciledThrough: { sessionID: orchestratorSessionID, seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID,
      runtimeID: "runtime",
      bindingState: "ACTIVE",
      bindingGeneration: generation,
      ownerRunID: "run",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    capacity: {
      maxConcurrentLanes: 0,
      activeLaneIDs: [],
      activeCount: 0,
      available: null,
      capacityReached: false,
      readyLaneIDs: [],
    },
    workflow: { id: "workflow", status: "ACTIVE", goal: "Debug lane" },
    lanes: [
      {
        id: "lane_debug",
        name: "Debug lane",
        status: "OPEN",
        stableStatus: "OPEN",
        displayStatus: "WORKING",
        updatedAt: now,
        reopenCount: 0,
        repairCycle: 0,
        dependsOnLaneIDs: [],
        coordinatorSlotID: "slot_debug_coordinator",
        coordinatorRuntimeReadiness: "bound",
        checkerRuntimeReadiness: "unmaterialized",
        coordinatorRuntime: {
          slotID: "slot_debug_coordinator",
          instanceID: "inst_coordinator",
          sessionID: "ses_coordinator",
        },
      },
    ],
    agents: [
      {
        instanceID: "inst_coordinator",
        role: "coordinator",
        sessionID: "ses_coordinator",
        orchestratorSessionID,
        status: "ASSIGNED",
        laneIDs: ["lane_debug"],
      },
    ],
    artifacts: [],
    resourceBlocks: [],
    incidents: [],
    functionSlots: [],
    runtimeExecutions: [],
    executionHistory: [],
    attentionItems: [],
    runtimeWarnings: [],
    attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
    diagnostics: [],
  }
}
