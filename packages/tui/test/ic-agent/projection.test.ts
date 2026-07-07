import { expect, test } from "bun:test"
import type { AssistantMessage, Session, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { icCommandSpecs } from "../../src/ic-agent/commands"
import { icFeature } from "../../src/ic-agent/feature-policy"
import { projectIcTui } from "../../src/ic-agent/projection"

test("projects OpenCode sessions into IC Agent focus, agents, diagnostics, and transcript", () => {
  const sessions: Session[] = [
    session("ses_checker", "checker lane_1", 200),
    session("ses_orchestrator", "orchestrator", 100),
  ]
  const user = userMessage("msg_user", "ses_orchestrator")
  const assistant = assistantMessage("msg_assistant", "ses_orchestrator")
  const model = projectIcTui({
    sessions,
    messages: {
      ses_orchestrator: [user, assistant],
    },
    parts: {
      msg_user: [textPart("part_user", user.id, user.sessionID, "please inspect coverage")],
      msg_assistant: [textPart("part_assistant", assistant.id, assistant.sessionID, "I will start the workflow")],
    },
    statuses: {
      ses_checker: { type: "busy" },
      ses_orchestrator: { type: "idle" },
    },
  })

  expect(model.surfaceLevel).toBe("multi_agent_active")
  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orchestrator" })
  expect(model.focusSessionID).toBe("ses_orchestrator")
  expect(model.agents.map((agent) => agent.role)).toEqual(["checker", "orchestrator"])
  expect(model.cockpit.counts).toMatchObject({
    lanes: 0,
    agents: 2,
    sessions: 2,
    diagnostics: 1,
    attention: 0,
    evidence: 0,
  })
  expect(model.diagnostics).toContainEqual({
    id: "busy",
    severity: "info",
    title: "1 active session",
    detail: "checker",
    source: "opencode.session.status",
    targetType: "session",
    targetID: "ses_checker",
    recommendation: "Wait for the active session to become idle before sending intervention prompts.",
    evidence: "checker:ses_checker",
    readonly: true,
    sessionID: "ses_checker",
  })
  expect(model.transcript.map((item) => item.text)).toEqual(["please inspect coverage", "I will start the workflow"])
})

test("resolves focus from IC workflow agents before OpenCode sessions are hydrated", () => {
  const model = projectIcTui({
    sessions: [],
    messages: {},
    parts: {},
    statuses: {},
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "WORKING",
        updatedAt: "2026-06-14T01:02:03.000Z",
        lastCheckResult: "REWORK",
        pendingCheckSummary: "waiting on coverage evidence",
        reopenCount: 1,
        repairCycle: 2,
        checkerSessionID: "ses_checker",
        coordinatorSessionID: "ses_coord",
      }],
      agents: [{
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orch",
        status: "ALIVE",
        laneIDs: [],
      }],
      artifacts: [{
        id: "artifact:doc",
        kind: "doc",
        title: "coverage.md",
        path: "/run/docs/coverage.md",
        detail: "docs/coverage.md · 1 KB",
        mtime: 10,
      }],
      diagnostics: [],
    },
  })

  expect(model.surfaceLevel).toBe("workflow_active")
  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orch" })
  expect(model.focusSessionID).toBe("ses_orch")
  expect(model.lanes[0]).toMatchObject({
    id: "lane_1",
    checkerSessionID: "ses_checker",
    coordinatorSessionID: "ses_coord",
    lastCheckResult: "REWORK",
    pendingCheckSummary: "waiting on coverage evidence",
    reopenCount: 1,
    repairCycle: 2,
  })
  expect(model.cockpit.counts).toMatchObject({
    lanes: 1,
    agents: 1,
    sessions: 1,
    diagnostics: 0,
    attention: 0,
    evidence: 1,
  })
  expect(model.cockpit.laneStatus).toEqual([{ status: "WORKING", count: 1 }])
  expect(model.agents[0]).toMatchObject({
    id: "inst_orch",
    role: "orchestrator",
    sessionID: "ses_orch",
    selected: true,
  })
  expect(model.artifacts[0]).toMatchObject({
    kind: "doc",
    title: "coverage.md",
  })
})

test("includes workflow-bound child sessions in the cockpit without using them as the startup entrypoint", () => {
  const sessions: Session[] = [
    session("ses_checker_child", "checker coverage", 300, "ses_orchestrator"),
    session("ses_orchestrator", "orchestrator", 100),
  ]
  const model = projectIcTui({
    sessions,
    messages: {
      ses_checker_child: [assistantMessage("msg_checker", "ses_checker_child")],
    },
    parts: {
      msg_checker: [textPart("part_checker", "msg_checker", "ses_checker_child", "coverage still below target")],
    },
    statuses: {
      ses_checker_child: { type: "busy" },
      ses_orchestrator: { type: "idle" },
    },
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "CHECKING",
        checkerSessionID: "ses_checker_child",
      }],
      agents: [{
        instanceID: "inst_checker",
        role: "checker",
        sessionID: "ses_checker_child",
        status: "BUSY",
        laneIDs: ["lane_1"],
      }],
      artifacts: [],
      diagnostics: [],
    },
  })

  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orchestrator" })
  expect(model.focusSessionID).toBe("ses_orchestrator")
  expect(model.sessions.map((item) => item.id)).toEqual(["ses_orchestrator", "ses_checker_child"])
  expect(model.sessions.find((item) => item.id === "ses_checker_child")).toMatchObject({
    role: "checker",
    status: "busy",
    messageCount: 1,
    selected: false,
  })
  expect(model.cockpit.counts.sessions).toBe(2)

  const laneFocused = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_checker_child: { type: "busy" },
      ses_orchestrator: { type: "idle" },
    },
    selectedLaneID: "lane_1",
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "CHECKING",
        checkerSessionID: "ses_checker_child",
      }],
      agents: [{
        instanceID: "inst_checker",
        role: "checker",
        sessionID: "ses_checker_child",
        status: "BUSY",
        laneIDs: ["lane_1"],
      }],
      artifacts: [],
      diagnostics: [],
    },
  })

  expect(laneFocused.focus).toEqual({
    type: "lane",
    laneID: "lane_1",
    name: "coverage",
    status: "CHECKING",
    sessionID: "ses_orchestrator",
    laneRole: "orchestrator",
  })
  expect(laneFocused.focusSessionID).toBe("ses_orchestrator")
  expect(laneFocused.laneBoard.selectedLaneID).toBe("lane_1")
  expect(laneFocused.laneBoard.rows[0]).toMatchObject({
    laneID: "lane_1",
    statusLabel: "CHECKING",
    tone: "checking",
    selected: true,
  })
  expect(laneFocused.sessions.find((item) => item.id === "ses_checker_child")?.selected).toBe(false)

  const roleFocused = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_checker_child: { type: "busy" },
      ses_orchestrator: { type: "idle" },
    },
    selectedLaneID: "lane_1",
    selectedLaneRole: "checker",
    workflow: laneFocusedInputWorkflow(),
  })

  expect(roleFocused.focus).toEqual({
    type: "lane",
    laneID: "lane_1",
    name: "coverage",
    status: "CHECKING",
    sessionID: "ses_orchestrator",
    laneRole: "orchestrator",
  })
  expect(roleFocused.focusSessionID).toBe("ses_orchestrator")
  expect(roleFocused.sessions.find((item) => item.id === "ses_checker_child")?.selected).toBe(false)
})

test("prefers workflow orchestrator over newer ordinary session even when the user selects a session", () => {
  const sessions: Session[] = [
    session("ses_recent", "New session - ordinary", 300),
    session("ses_other", "checker unrelated", 200),
  ]
  const workflow = workflowSnapshot()

  const automatic = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {},
    workflow,
  })

  expect(automatic.focus).toEqual({ type: "orchestrator", sessionID: "ses_workflow_orch" })
  expect(automatic.focusSessionID).toBe("ses_workflow_orch")
  expect(automatic.sessions.find((item) => item.id === "ses_workflow_orch")).toMatchObject({
    role: "orchestrator",
    selected: true,
  })
  expect(automatic.agents[0]).toMatchObject({
    role: "orchestrator",
    selected: true,
  })

  const manual = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {},
    selectedSessionID: "ses_recent",
    workflow,
  })

  expect(manual.focusSessionID).toBe("ses_workflow_orch")
  expect(manual.focus).toEqual({ type: "orchestrator", sessionID: "ses_workflow_orch" })
  expect(manual.sessions.some((item) => item.id !== "ses_workflow_orch" && item.selected)).toBe(false)
})

test("selects lane board row without switching to checker or coordinator sessions", () => {
  const model = projectIcTui({
    sessions: [],
    messages: {},
    parts: {},
    statuses: {},
    selectedLaneID: "lane_1",
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "CHECKING",
        updatedAt: "2026-06-14T01:02:03.000Z",
        lastCheckResult: "PASS",
        checkerSessionID: "ses_checker",
        coordinatorSessionID: "ses_coord",
      }],
      agents: [{
        instanceID: "inst_checker",
        role: "checker",
        sessionID: "ses_checker",
        status: "ALIVE",
        laneIDs: ["lane_1"],
      }],
      artifacts: [],
      diagnostics: [],
    },
  })

  expect(model.focus).toEqual({
    type: "lane",
    laneID: "lane_1",
    name: "coverage",
    status: "CHECKING",
    sessionID: undefined,
    laneRole: "orchestrator",
  })
  expect(model.focusSessionID).toBe("")
  expect(model.lanes[0]?.selected).toBe(true)
  expect(model.lanes[0]?.focusedRole).toBe(undefined)
  expect(model.lanes[0]?.checker).toMatchObject({
    role: "checker",
    sessionID: "ses_checker",
    selected: false,
    recommended: true,
  })
  expect(model.laneBoard.selectedLaneID).toBe("lane_1")
  expect(model.laneBoard.rows[0]).toMatchObject({
    laneID: "lane_1",
    label: "coverage",
    statusLabel: "CHECKING",
    tone: "checking",
    selected: true,
  })
  expect(model.lanes[0]).toMatchObject({
    lastCheckResult: "PASS",
    updatedAt: "2026-06-14T01:02:03.000Z",
  })
  expect(model.agents[0]).toMatchObject({
    role: "checker",
    laneIDs: ["lane_1"],
    selected: false,
  })
})

test("projects lane dependencies into sequential lane board rows", () => {
  const model = projectIcTui({
    sessions: [],
    messages: {},
    parts: {},
    statuses: {},
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [
        { id: "parse", name: "parse", status: "DONE" },
        { id: "compile", name: "compile", status: "WORKING", dependsOnLaneIDs: ["parse"] },
        { id: "lint", name: "lint", status: "WORKING", dependsOnLaneIDs: ["parse"] },
        { id: "signoff", name: "signoff", status: "OPEN", dependsOnLaneIDs: ["compile", "lint"] },
      ],
      agents: [],
      artifacts: [],
      diagnostics: [],
    },
  })

  expect(model.laneBoard.summary).toMatchObject({
    total: 4,
    done: 1,
    active: 2,
    open: 1,
  })
  expect(model.laneBoard.rows.map((row) => ({
    laneID: row.laneID,
    depth: row.depth,
    branch: row.branch,
    needs: row.needs,
  }))).toEqual([
    { laneID: "parse", depth: 0, branch: "root", needs: [] },
    { laneID: "compile", depth: 0, branch: "root", needs: ["01"] },
    { laneID: "lint", depth: 0, branch: "root", needs: ["01"] },
    { laneID: "signoff", depth: 0, branch: "root", needs: ["02", "03"] },
  ])
})

test("ignores lane role navigation and keeps orchestrator as the product entry", () => {
  const sessions: Session[] = [
    session("ses_orch", "orchestrator", 300),
    session("ses_coord", "coordinator coverage", 200, "ses_orch"),
    session("ses_checker", "checker coverage", 100, "ses_orch"),
  ]
  const workflow = {
    stateDb: "/run/.ic-agent/state.db",
    workflow: {
      id: "wf_1",
      status: "active",
      goal: "close coverage",
    },
    lanes: [{
      id: "lane_1",
      name: "coverage",
      status: "WORKING",
      lastCheckResult: "PASS",
      checkerSessionID: "ses_checker",
      coordinatorSessionID: "ses_coord",
    }],
    agents: [
      {
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orch",
        status: "ALIVE",
        laneIDs: [],
      },
      {
        instanceID: "inst_coord",
        role: "coordinator",
        sessionID: "ses_coord",
        status: "ALIVE",
        laneIDs: ["lane_1"],
      },
      {
        instanceID: "inst_checker",
        role: "checker",
        sessionID: "ses_checker",
        status: "BUSY",
        laneIDs: ["lane_1"],
      },
    ],
    artifacts: [],
    diagnostics: [],
  } satisfies NonNullable<Parameters<typeof projectIcTui>[0]["workflow"]>
  const defaultFocus = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "busy" },
    },
    selectedLaneID: "lane_1",
    workflow,
  })

  expect(defaultFocus.focus).toMatchObject({
    type: "lane",
    laneRole: "orchestrator",
    sessionID: "ses_orch",
  })
  expect(defaultFocus.focusSessionID).toBe("ses_orch")
  expect(defaultFocus.laneBoard.selectedLaneID).toBe("lane_1")
  expect(defaultFocus.laneBoard.rows[0]).toMatchObject({
    laneID: "lane_1",
    selected: true,
    tone: "active",
  })
  expect(defaultFocus.lanes[0]).toMatchObject({
    recommendedRole: "coordinator",
    focusedRole: undefined,
    coordinator: {
      selected: false,
      recommended: true,
      status: "idle",
    },
    checker: {
      selected: false,
      recommended: false,
      status: "busy",
    },
  })

  const coordinatorFocus = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "busy" },
    },
    selectedLaneID: "lane_1",
    selectedLaneRole: "coordinator",
    workflow,
  })

  expect(coordinatorFocus.focus).toMatchObject({
    type: "lane",
    laneRole: "orchestrator",
    sessionID: "ses_orch",
  })
  expect(coordinatorFocus.focusSessionID).toBe("ses_orch")
  expect(coordinatorFocus.sessions.find((item) => item.id === "ses_coord")?.selected).toBe(false)
  expect(coordinatorFocus.lanes[0]).toMatchObject({
    recommendedRole: "coordinator",
    focusedRole: undefined,
    coordinator: {
      selected: false,
      recommended: true,
      status: "idle",
    },
    checker: {
      selected: false,
      recommended: false,
      status: "busy",
    },
  })

  const checkerFocus = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "busy" },
    },
    selectedLaneID: "lane_1",
    selectedLaneRole: "checker",
    workflow,
  })

  expect(checkerFocus.focus).toMatchObject({
    type: "lane",
    laneRole: "orchestrator",
    sessionID: "ses_orch",
  })
  expect(checkerFocus.focusSessionID).toBe("ses_orch")
  expect(checkerFocus.sessions.find((item) => item.id === "ses_checker")?.selected).toBe(false)
  expect(checkerFocus.lanes[0]).toMatchObject({
    recommendedRole: "coordinator",
    focusedRole: undefined,
    coordinator: {
      selected: false,
      recommended: true,
    },
    checker: {
      selected: false,
      recommended: false,
    },
  })
})

test("keeps diagnostics as workflow context instead of navigation focus", () => {
  const sessions: Session[] = [
    session("ses_checker", "checker lane_1", 200),
    session("ses_orchestrator", "orchestrator", 100),
  ]
  const model = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_checker: { type: "busy" },
      ses_orchestrator: { type: "idle" },
    },
  })

  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orchestrator" })
  expect(model.focusSessionID).toBe("ses_orchestrator")
  expect(model.diagnostics.find((item) => item.id === "busy")).toMatchObject({
    title: "1 active session",
    targetID: "ses_checker",
  })
  expect(model.sessions.find((item) => item.id === "ses_checker")?.selected).toBe(false)
})

test("preserves workflow blocker metadata without turning it into focus", () => {
  const model = projectIcTui({
    sessions: [],
    messages: {},
    parts: {},
    statuses: {},
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [],
      agents: [{
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orchestrator",
        status: "ALIVE",
        laneIDs: [],
      }],
      artifacts: [],
      diagnostics: [{
        id: "pending-delivery",
        severity: "warn",
        title: "1 pending delivery item",
        detail: "messages.delivery_status = PENDING_DELIVERY",
        source: "ic.state_db.messages",
        targetType: "message",
        targetID: "messages",
        recommendation: "Check whether the target agent session is busy or missing before sending more intervention prompts.",
        evidence: "/run/.ic-agent/state.db",
        readonly: true,
      }],
    },
  })

  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orchestrator" })
  expect(model.diagnostics[0]).toMatchObject({
    source: "ic.state_db.messages",
    targetType: "message",
    targetID: "messages",
    evidence: "/run/.ic-agent/state.db",
  })
  expect(model.cockpit.counts.attention).toBe(1)
  expect(model.surfaceLevel).toBe("workflow_attention")
})

test("selects artifact context while preserving the current conversation focus", () => {
  const sessions: Session[] = [
    session("ses_orchestrator", "orchestrator", 100),
  ]
  const model = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_orchestrator: { type: "idle" },
    },
    selectedArtifactID: "artifact:doc",
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [],
      agents: [{
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orchestrator",
        status: "ALIVE",
        laneIDs: [],
      }],
      artifacts: [{
        id: "artifact:doc",
        kind: "doc",
        title: "coverage.md",
        path: "/run/docs/coverage.md",
        detail: "docs/coverage.md · 1 KB",
        mtime: 10,
      }],
      diagnostics: [],
    },
  })

  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orchestrator" })
  expect(model.focusSessionID).toBe("ses_orchestrator")
  expect(model.artifacts[0]?.selected).toBe(true)
  expect(model.sessions.find((item) => item.id === "ses_orchestrator")?.selected).toBe(true)
})

test("keeps a plain no-workflow session in single-agent surface level", () => {
  const model = projectIcTui({
    sessions: [session("ses_plain", "New session", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_plain: { type: "idle" },
    },
  })

  expect(model.surfaceLevel).toBe("single_agent")
  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_plain" })
  expect(model.workflow).toMatchObject({
    active: true,
    title: "IC Agent workspace",
  })
})

test("new session mode starts empty instead of auto-resuming a prior orchestrator", () => {
  const model = projectIcTui({
    sessions: [session("ses_old_orch", "orchestrator", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_old_orch: { type: "idle" },
    },
    sessionMode: "new",
  })

  expect(model.surfaceLevel).toBe("single_agent")
  expect(model.focus).toBe(null)
  expect(model.focusSessionID).toBe("")
  expect(model.workflow).toMatchObject({
    active: true,
    title: "IC Agent workspace",
  })
  expect(model.sessions.find((item) => item.id === "ses_old_orch")?.selected).toBe(false)
})

test("resume session mode honors the requested conversation before workflow exists", () => {
  const model = projectIcTui({
    sessions: [
      session("ses_recent", "orchestrator recent", 200),
      session("ses_requested", "orchestrator requested", 100),
    ],
    messages: {},
    parts: {},
    statuses: {
      ses_recent: { type: "idle" },
      ses_requested: { type: "idle" },
    },
    selectedSessionID: "ses_requested",
    sessionMode: "resume",
  })

  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_requested" })
  expect(model.focusSessionID).toBe("ses_requested")
  expect(model.sessions.find((item) => item.id === "ses_requested")?.selected).toBe(true)
  expect(model.sessions.find((item) => item.id === "ses_recent")?.selected).toBe(false)
})

test("resume session mode refuses known internal sessions as the product entry", () => {
  const model = projectIcTui({
    sessions: [
      session("ses_checker", "checker coverage lane", 300),
      session("ses_orchestrator", "orchestrator", 100),
    ],
    messages: {},
    parts: {},
    statuses: {
      ses_checker: { type: "idle" },
      ses_orchestrator: { type: "idle" },
    },
    selectedSessionID: "ses_checker",
    sessionMode: "resume",
  })

  expect(model.focus).toEqual({ type: "orchestrator", sessionID: "ses_orchestrator" })
  expect(model.focusSessionID).toBe("ses_orchestrator")
  expect(model.sessions.find((item) => item.id === "ses_checker")?.selected).toBe(false)
  expect(model.sessions.find((item) => item.id === "ses_orchestrator")?.selected).toBe(true)
})

test("debug view can focus an internal lane session without changing product defaults", () => {
  const sessions = [
    session("ses_orch", "orchestrator", 100),
    session("ses_coord", "coordinator coverage", 200),
    session("ses_checker", "checker coverage", 300),
  ]
  const workflow = {
    stateDb: "/run/.ic-agent/state.db",
    workflow: {
      id: "wf_1",
      status: "active",
      goal: "close coverage",
    },
    lanes: [{
      id: "lane_1",
      name: "coverage",
      status: "CHECKING",
      coordinatorSessionID: "ses_coord",
      checkerSessionID: "ses_checker",
    }],
    agents: [{
      instanceID: "inst_orch",
      role: "orchestrator",
      sessionID: "ses_orch",
      status: "ALIVE",
      laneIDs: [],
    }, {
      instanceID: "inst_coord",
      role: "coordinator",
      sessionID: "ses_coord",
      status: "ALIVE",
      laneIDs: ["lane_1"],
    }, {
      instanceID: "inst_checker",
      role: "checker",
      sessionID: "ses_checker",
      status: "BUSY",
      laneIDs: ["lane_1"],
    }],
    artifacts: [],
    diagnostics: [],
  } satisfies NonNullable<Parameters<typeof projectIcTui>[0]["workflow"]>

  const productModel = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "busy" },
    },
    selectedSessionID: "ses_checker",
    selectedLaneID: "lane_1",
    selectedLaneRole: "checker",
    workflow,
  })

  expect(productModel.focusSessionID).toBe("ses_orch")
  expect(productModel.focus).toMatchObject({
    type: "lane",
    laneRole: "orchestrator",
    sessionID: "ses_orch",
  })
  expect(productModel.lanes[0]?.checker.selected).toBe(false)

  const debugModel = projectIcTui({
    sessions,
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "busy" },
    },
    selectedSessionID: "ses_checker",
    selectedLaneID: "lane_1",
    selectedLaneRole: "checker",
    debugView: true,
    workflow,
  })

  expect(debugModel.focusSessionID).toBe("ses_checker")
  expect(debugModel.focus).toMatchObject({
    type: "lane",
    laneRole: "checker",
    sessionID: "ses_checker",
  })
  expect(debugModel.sessions.find((item) => item.id === "ses_checker")?.selected).toBe(true)
  expect(debugModel.agents.find((item) => item.sessionID === "ses_checker")?.selected).toBe(true)
  expect(debugModel.lanes[0]).toMatchObject({
    focusedRole: "checker",
    checker: {
      selected: true,
      status: "busy",
    },
  })

  const debugCommands = icCommandSpecs(debugModel, { debugView: true })
  expect(debugCommands.map((command) => command.slashName)).toEqual([
    "orchestrator",
    "sessions",
    "refresh",
    "workflow",
    "lane",
    "coordinator",
    "checker",
  ])
  expect(debugCommands.find((command) => command.id === "ic.orchestrator.focus")?.intent).toEqual({
    type: "focus-session",
    sessionID: "ses_orch",
  })
  expect(debugCommands.find((command) => command.id === "ic.debug.coordinator")?.intent).toEqual({
    type: "focus-lane-role",
    laneID: "lane_1",
    role: "coordinator",
  })
  expect(debugCommands.find((command) => command.id === "ic.debug.checker")?.intent).toEqual({
    type: "focus-lane-role",
    laneID: "lane_1",
    role: "checker",
  })
})

test("debug view can focus a workflow agent before its OpenCode session is hydrated", () => {
  const model = projectIcTui({
    sessions: [session("ses_orch", "orchestrator", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
    },
    selectedSessionID: "ses_coord",
    selectedLaneID: "lane_1",
    selectedLaneRole: "coordinator",
    debugView: true,
    workflow: {
      stateDb: "/run/.motryx/db/orchestrators/ses_orch/ic-agent.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "WORKING",
        coordinatorSessionID: "ses_coord",
      }],
      agents: [{
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orch",
        status: "ALIVE",
        laneIDs: [],
      }, {
        instanceID: "inst_coord",
        role: "coordinator",
        sessionID: "ses_coord",
        status: "ALIVE",
        laneIDs: ["lane_1"],
      }],
      artifacts: [],
      diagnostics: [],
    },
  })

  expect(model.focusSessionID).toBe("ses_coord")
  expect(model.focus).toMatchObject({
    type: "lane",
    laneRole: "coordinator",
    sessionID: "ses_coord",
  })
  expect(model.sessions.find((item) => item.id === "ses_coord")).toMatchObject({
    role: "coordinator",
    selected: true,
  })
  expect(model.agents.find((item) => item.sessionID === "ses_coord")?.selected).toBe(true)
  expect(icCommandSpecs(model, { debugView: true }).find((command) => command.slashName === "orchestrator")?.intent).toEqual({
    type: "focus-session",
    sessionID: "ses_orch",
  })
  expect(icCommandSpecs(model, { debugView: true }).find((command) => command.slashName === "coordinator")).toMatchObject({
    enabled: true,
    intent: {
      type: "focus-lane-role",
      laneID: "lane_1",
      role: "coordinator",
    },
  })
  expect(icCommandSpecs(model, { debugView: true }).find((command) => command.slashName === "checker")).toMatchObject({
    enabled: false,
    intent: {
      type: "sidecard",
      mode: "debug",
    },
  })
})

test("debug view infers the focused lane role from a lane-bound internal session", () => {
  const model = projectIcTui({
    sessions: [session("ses_orch", "orchestrator", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
    },
    selectedSessionID: "ses_coord",
    debugView: true,
    workflow: {
      stateDb: "/run/.motryx/db/orchestrators/ses_orch/ic-agent.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "WORKING",
        coordinatorSessionID: "ses_coord",
      }],
      agents: [{
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orch",
        status: "ALIVE",
        laneIDs: [],
      }],
      artifacts: [],
      diagnostics: [],
    },
  })

  expect(model.focusSessionID).toBe("ses_coord")
  expect(model.focus).toMatchObject({
    type: "lane",
    laneRole: "coordinator",
    sessionID: "ses_coord",
    laneID: "lane_1",
  })
  expect(model.lanes[0]).toMatchObject({
    selected: true,
    focusedRole: "coordinator",
    coordinator: {
      selected: true,
      sessionID: "ses_coord",
    },
    checker: {
      selected: false,
    },
  })
  expect(icCommandSpecs(model, { debugView: true }).find((command) => command.slashName === "coordinator")).toMatchObject({
    enabled: true,
    intent: {
      type: "focus-lane-role",
      laneID: "lane_1",
      role: "coordinator",
    },
  })
  expect(icCommandSpecs(model, { debugView: true }).find((command) => command.slashName === "checker")).toMatchObject({
    enabled: false,
    intent: {
      type: "sidecard",
      mode: "debug",
    },
  })
})

test("debug view can return from an internal lane session to the owner orchestrator target", () => {
  const workflow = {
    stateDb: "/run/.motryx/db/orchestrators/ses_orch/ic-agent.db",
    workflow: {
      id: "wf_1",
      status: "active",
      goal: "close coverage",
    },
    lanes: [{
      id: "lane_1",
      name: "coverage",
      status: "WORKING",
      coordinatorSessionID: "ses_coord",
      checkerSessionID: "ses_checker",
    }],
    agents: [{
      instanceID: "inst_orch",
      role: "orchestrator",
      sessionID: "ses_orch",
      status: "ALIVE",
      laneIDs: [],
    }, {
      instanceID: "inst_coord",
      role: "coordinator",
      sessionID: "ses_coord",
      status: "ALIVE",
      laneIDs: ["lane_1"],
    }, {
      instanceID: "inst_checker",
      role: "checker",
      sessionID: "ses_checker",
      status: "ALIVE",
      laneIDs: ["lane_1"],
    }],
    artifacts: [],
    diagnostics: [],
  } satisfies NonNullable<Parameters<typeof projectIcTui>[0]["workflow"]>

  const coordinatorModel = projectIcTui({
    sessions: [session("ses_orch", "orchestrator", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "idle" },
    },
    selectedSessionID: "ses_coord",
    selectedLaneID: "lane_1",
    selectedLaneRole: "coordinator",
    debugView: true,
    workflow,
  })
  expect(coordinatorModel.focusSessionID).toBe("ses_coord")
  expect(coordinatorModel.focus).toMatchObject({
    type: "lane",
    laneRole: "coordinator",
    sessionID: "ses_coord",
  })
  expect(coordinatorModel.lanes[0]?.coordinator.selected).toBe(true)

  const orchestratorModel = projectIcTui({
    sessions: [session("ses_orch", "orchestrator", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_orch: { type: "idle" },
      ses_coord: { type: "idle" },
      ses_checker: { type: "idle" },
    },
    selectedSessionID: "ses_orch",
    selectedLaneID: "lane_1",
    selectedLaneRole: undefined,
    debugView: true,
    workflow,
  })

  expect(orchestratorModel.focusSessionID).toBe("ses_orch")
  expect(orchestratorModel.focus).toMatchObject({
    type: "lane",
    laneRole: "orchestrator",
    sessionID: "ses_orch",
  })
  expect(orchestratorModel.lanes[0]?.selected).toBe(true)
  expect(orchestratorModel.lanes[0]?.coordinator.selected).toBe(false)
  expect(orchestratorModel.agents.find((agent) => agent.sessionID === "ses_orch")?.selected).toBe(true)
  expect(orchestratorModel.agents.find((agent) => agent.sessionID === "ses_coord")?.selected).toBe(false)
})

test("continue mode does not use a known internal session as the fallback entry", () => {
  const model = projectIcTui({
    sessions: [session("ses_checker", "checker coverage lane", 300)],
    messages: {},
    parts: {},
    statuses: {
      ses_checker: { type: "idle" },
    },
    sessionMode: "continue",
  })

  expect(model.focus).toBe(null)
  expect(model.focusSessionID).toBe("")
  expect(model.sessions.find((item) => item.id === "ses_checker")?.selected).toBe(false)
})

test("builds IC slash command intents from the current view model", () => {
  const model = projectIcTui({
    sessions: [session("ses_orchestrator", "orchestrator", 100)],
    messages: {},
    parts: {},
    statuses: {
      ses_orchestrator: { type: "idle" },
    },
    workflow: {
      stateDb: "/run/.ic-agent/state.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "close coverage",
      },
      lanes: [{
        id: "lane_1",
        name: "coverage",
        status: "CHECKING",
        updatedAt: "2026-06-14T01:02:03.000Z",
        checkerSessionID: "ses_checker",
        coordinatorSessionID: "ses_coord",
      }],
      agents: [{
        instanceID: "inst_checker",
        role: "checker",
        sessionID: "ses_checker",
        status: "ALIVE",
        laneIDs: ["lane_1"],
      }],
      artifacts: [{
        id: "artifact:doc",
        kind: "doc",
        title: "coverage.md",
        path: "/run/docs/coverage.md",
        detail: "docs/coverage.md · 1 KB",
        mtime: 10,
      }],
      diagnostics: [{
        id: "pending-delivery",
        severity: "warn",
        title: "1 pending delivery item",
        detail: "/run/.ic-agent/state.db",
        source: "ic.state_db.messages",
        targetType: "message",
        targetID: "messages",
        recommendation: "Check whether the target agent session is busy or missing before sending more intervention prompts.",
        evidence: "/run/.ic-agent/state.db",
        readonly: true,
      }],
    },
  })
  const commands = icCommandSpecs(model)

  expect(commands.map((command) => command.slashName)).toEqual([
    "orchestrator",
    "sessions",
    "refresh",
    "workflow",
    "lane",
  ])
  expect(commands.find((command) => command.id === "ic.lane.focus")?.intent).toEqual({
    type: "focus-lane",
    laneID: "lane_1",
  })
  expect(commands.find((command) => command.id === "ic.lane.focus")?.description).toContain("lane board")
  expect(commands.find((command) => command.id === "ic.orchestrator.focus")?.intent).toEqual({
    type: "focus-session",
    sessionID: "ses_orchestrator",
  })
  expect(commands.find((command) => command.id === "ic.orchestrator.sessions")?.intent).toEqual({
    type: "open-sessions",
  })
  expect(commands.find((command) => command.id === "ic.orchestrator.sessions")?.slashAliases).toEqual([
    "resume",
    "continue",
    "orchestrators",
    "history",
  ])
  expect(commands.find((command) => command.id === "ic.orchestrator.sessions")?.description).toContain("Coordinator and checker")
  expect(commands.find((command) => command.id === "ic.workflow.refresh")?.intent).toEqual({
    type: "refresh-workflow",
  })
  expect(commands.some((command) => command.slashName === "agent")).toBe(false)
  expect(commands.some((command) => command.slashName === "session")).toBe(false)
  expect(commands.some((command) => command.slashName === "diag")).toBe(false)
  expect(commands.some((command) => command.slashName === "evidence")).toBe(false)
})

test("documents IC feature policy for native escape hatches and hidden command log", () => {
  expect(icFeature("native.session.open")).toMatchObject({
    visibility: "demote",
  })
  expect(icFeature("native.command-log")).toMatchObject({
    visibility: "hide",
  })
  expect(icFeature("ic.workflow")).toMatchObject({
    visibility: "show",
  })
  expect(icFeature("ic.lane")).toMatchObject({
    label: "Lane board",
  })
})

test("projects provider resource blocks as lane attention without switching focus", () => {
  const view = projectIcTui({
    sessions: [session("ses_orchestrator", "orchestrator", 10)],
    messages: {},
    parts: {},
    statuses: {},
    selectedSessionID: "ses_orchestrator",
    workflow: {
      stateDb: "/run/.motryx/db/orchestrators/ses/ic-agent.db",
      workflow: {
        id: "wf_1",
        status: "active",
        goal: "quota recovery",
      },
      lanes: [{
        id: "lane_1",
        name: "review",
        status: "PENDING",
        coordinatorSessionID: "ses_coord",
      }],
      agents: [{
        instanceID: "inst_orch",
        role: "orchestrator",
        sessionID: "ses_orchestrator",
        status: "ALIVE",
        laneIDs: [],
      }],
      artifacts: [],
      resourceBlocks: [{
        id: "resource-block:fact_1",
        factID: "fact_1",
        factKey: "resource.llm.openai.gpt-5.5.provider_resource_exhausted",
        laneID: "lane_1",
        laneName: "review",
        providerID: "openai",
        modelID: "gpt-5.5",
        errorMessage: "quota exhausted",
        humanActionRequired: true,
        automaticProviderFallback: false,
      }],
      diagnostics: [],
    },
  })

  expect(view.focus?.type).toBe("orchestrator")
  expect(view.resourceBlocks).toHaveLength(1)
  expect(view.lanes[0]!.resourceBlock?.providerID).toBe("openai")
  expect(view.laneBoard.summary.blocked).toBe(1)
  expect(view.laneBoard.nextAttentionLaneID).toBe("lane_1")
  expect(view.graph.selected?.whyNow).toBe("LLM quota or provider resource is blocked")
})

function session(id: string, title: string, updated: number, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/workspace",
    title,
    version: "1",
    time: {
      created: 1,
      updated,
    },
    parentID,
  }
}

function workflowSnapshot() {
  return {
    stateDb: "/run/.ic-agent/state.db",
    workflow: {
      id: "wf_1",
      status: "active",
      goal: "close coverage",
    },
    lanes: [],
    agents: [{
      instanceID: "inst_orch",
      role: "orchestrator",
      sessionID: "ses_workflow_orch",
      status: "ALIVE",
      laneIDs: [],
    }],
    artifacts: [],
    diagnostics: [],
  }
}

function laneFocusedInputWorkflow() {
  return {
    stateDb: "/run/.ic-agent/state.db",
    workflow: {
      id: "wf_1",
      status: "active",
      goal: "close coverage",
    },
    lanes: [{
      id: "lane_1",
      name: "coverage",
      status: "CHECKING",
      checkerSessionID: "ses_checker_child",
    }],
    agents: [{
      instanceID: "inst_checker",
      role: "checker",
      sessionID: "ses_checker_child",
      status: "BUSY",
      laneIDs: ["lane_1"],
    }],
    artifacts: [],
    diagnostics: [],
  } satisfies NonNullable<Parameters<typeof projectIcTui>[0]["workflow"]>
}

function userMessage(id: string, sessionID: string): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: {
      created: 1,
    },
    agent: "orchestrator",
    model: {
      providerID: "test",
      modelID: "model",
    },
  }
}

function assistantMessage(id: string, sessionID: string): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: {
      created: 2,
      completed: 3,
    },
    parentID: "msg_user",
    modelID: "model",
    providerID: "test",
    mode: "build",
    agent: "orchestrator",
    path: {
      cwd: "/workspace",
      root: "/workspace",
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
}

function textPart(id: string, messageID: string, sessionID: string, text: string): TextPart {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
  }
}
