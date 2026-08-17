import { describe, expect, test } from "bun:test"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import type { MotryxControlSnapshot } from "../../src/feature-plugins/motryx/control"
import { motryxProductLayout } from "../../src/feature-plugins/motryx/layout"
import {
  motryxDebugViewFromEnv,
  motryxLaneStatusLabel,
  resolveProjectedDebugTarget,
} from "../../src/feature-plugins/motryx/route"

describe("Motryx product TUI", () => {
  test("ships as an opt-in builtin on the ordinary plugin route", () => {
    const plugin = createBuiltinPlugins({ experimentalEventSystem: false }).find((item) => item.id === "motryx")
    expect(plugin).toBeDefined()
    expect(plugin?.enabled).toBe(false)
    expect(plugin?.server).toBeUndefined()
    expect(typeof plugin?.tui).toBe("function")
  })

  test("keeps conversation dominant across safe, short, stacked, and side layouts", () => {
    expect(motryxProductLayout({ width: 39, height: 24 })).toMatchObject({
      mode: "safe",
      sidecarHeight: 2,
      collapsedSidecar: true,
    })
    expect(motryxProductLayout({ width: 80, height: 16 })).toMatchObject({
      mode: "conversation-first",
      direction: "column",
      sidecarHeight: 2,
      collapsedSidecar: true,
    })
    expect(motryxProductLayout({ width: 80, height: 24 })).toMatchObject({ mode: "stacked", direction: "column" })
    expect(motryxProductLayout({ width: 100, height: 30 })).toMatchObject({
      mode: "compact-side",
      direction: "row",
      sidecarWidth: 42,
      sidecarHeight: "100%",
    })
    expect(motryxProductLayout({ width: 120, height: 40 })).toMatchObject({
      mode: "wide",
      sidecarWidth: 46,
      sidecarHeight: "100%",
    })
  })

  test("resolves debug sessions only from the lane's exact current runtime and agent agreement", () => {
    const snapshot = debugSnapshot()
    expect(resolveProjectedDebugTarget(snapshot, "lane_1", "coordinator")).toMatchObject({
      role: "coordinator",
      laneID: "lane_1",
      sessionID: "ses_coord",
      bindingGeneration: 7,
    })
    expect(resolveProjectedDebugTarget(snapshot, "lane_1", "checker")).toBeUndefined()
    snapshot.agents.unshift({
      instanceID: "inst_old_coord",
      role: "coordinator",
      sessionID: "ses_old_coord",
      orchestratorSessionID: "ses_orch",
      status: "ALIVE",
      laneIDs: ["lane_1"],
    })
    expect(resolveProjectedDebugTarget(snapshot, "lane_1", "coordinator")?.sessionID).toBe("ses_coord")
    snapshot.agents.find((agent) => agent.instanceID === "inst_coord")!.status = "DISMISSED"
    expect(resolveProjectedDebugTarget(snapshot, "lane_1", "coordinator")).toBeUndefined()
  })

  test("debug mode is explicit and is not inferred from a truthy string", () => {
    expect(motryxDebugViewFromEnv({ MOTRYX_DEBUG_VIEW: "1" })).toBe(true)
    expect(motryxDebugViewFromEnv({ MOTRYX_DEBUG_VIEW: "true" })).toBe(false)
    expect(motryxDebugViewFromEnv({})).toBe(false)
  })

  test("uses exact durable lane labels and marks future states as unknown", () => {
    expect(motryxLaneStatusLabel("AWAITING_CHECK")).toBe("AWAIT CHECK")
    expect(motryxLaneStatusLabel("reopened")).toBe("UNKNOWN · REOPENED")
    expect(motryxLaneStatusLabel("future_state")).toBe("UNKNOWN · FUTURE STATE")
  })
})

function debugSnapshot(): MotryxControlSnapshot {
  const now = "2026-07-19T00:00:00.000Z"
  return {
    schemaVersion: 6,
    projectID: "/tmp/project",
    orchestratorSessionID: "ses_orch",
    projectionRevision: "server:revision",
    route: {
      state: "ROUTABLE",
      serverGeneration: "server",
      sidecarGeneration: "server",
      bindingGeneration: 7,
      reconciledThrough: { sessionID: "ses_orch", seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID: "/tmp/project",
      orchestratorSessionID: "ses_orch",
      runtimeID: "runtime",
      bindingState: "ACTIVE",
      bindingGeneration: 7,
      ownerRunID: "run",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    workflow: { id: "workflow", status: "ACTIVE", goal: "Goal" },
    capacity: {
      maxConcurrentLanes: 1,
      activeLaneIDs: ["lane_1"],
      activeCount: 1,
      available: 0,
      capacityReached: true,
      readyLaneIDs: [],
    },
    lanes: [
      {
        id: "lane_1",
        name: "Lane one",
        status: "WORKING",
        updatedAt: now,
        reopenCount: 0,
        repairCycle: 0,
        dependsOnLaneIDs: [],
        coordinatorSlotID: "slot_coord",
        coordinatorRuntimeReadiness: "ready",
        checkerRuntimeReadiness: "unmaterialized",
        coordinatorRuntime: {
          slotID: "slot_coord",
          instanceID: "inst_coord",
          sessionID: "ses_coord",
        },
      },
    ],
    agents: [
      {
        instanceID: "inst_coord",
        role: "coordinator",
        sessionID: "ses_coord",
        orchestratorSessionID: "ses_orch",
        status: "ALIVE",
        laneIDs: ["lane_1"],
      },
    ],
    artifacts: [],
    resourceBlocks: [],
    incidents: [],
    functionSlots: [],
    runs: [],
    attempts: [],
    attentionItems: [],
    runtimeWarnings: [],
    attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
    diagnostics: [],
  }
}
