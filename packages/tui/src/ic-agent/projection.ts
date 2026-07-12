import type { Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2"
import type { IcWorkflowSnapshot } from "./workflow-adapter"
import {
  lanePresentation,
  type IcLaneActionability,
  type IcLaneBoardTone,
  type IcLanePhase,
} from "./lane-state"

export type { IcLaneBoardTone } from "./lane-state"

export type IcLaneRole = "coordinator" | "checker" | "orchestrator"

export type IcFocus =
  | {
      type: "orchestrator"
      sessionID: string
    }
  | {
      type: "lane"
      laneID: string
      name: string
      status: string
      sessionID?: string
      laneRole: IcLaneRole
    }
  | {
      type: "agent"
      agentID: string
      role: string
      sessionID: string
    }
  | {
      type: "workflow"
      workflowID: string
      sessionID: string
    }

export type IcSessionSummary = {
  id: string
  title: string
  role: string
  status: "idle" | "busy" | "retry" | "unknown"
  updated: number
  messageCount: number
  selected: boolean
}

export type IcAgentSummary = {
  id: string
  role: string
  sessionID: string
  laneIDs: string[]
  status: IcSessionSummary["status"]
  title: string
  selected: boolean
}

export type IcLaneRoleEntry = {
  role: Exclude<IcLaneRole, "orchestrator">
  label: string
  sessionID?: string
  status: IcSessionSummary["status"]
  selected: boolean
  available: boolean
  recommended: boolean
}

export type IcDiagnostic = {
  id: string
  severity: "info" | "warn" | "error"
  title: string
  detail: string
  source: string
  targetType: "workflow" | "lane" | "agent" | "session" | "message" | "outbox" | "wake" | "runtime"
  targetID: string
  recommendation: string
  evidence?: string
  readonly?: boolean
  sessionID?: string
  selected?: boolean
}

export type IcResourceBlock = NonNullable<IcWorkflowSnapshot["resourceBlocks"]>[number]

export type IcLaneSummary = {
  id: string
  name: string
  status: string
  updatedAt?: string
  lastCheckResult?: string
  pendingCheckSummary?: string
  reopenCount?: number
  repairCycle?: number
  dependsOnLaneIDs?: string[]
  coordinatorSessionID?: string
  checkerSessionID?: string
  resourceBlock?: IcResourceBlock
  phase: IcLanePhase
  displayStatus: string
  tone: IcLaneBoardTone
  actionability: IcLaneActionability
  terminal: boolean
  recommendedRole: IcLaneRole
  focusedRole?: IcLaneRole
  coordinator: IcLaneRoleEntry
  checker: IcLaneRoleEntry
  selected: boolean
}

export type IcWorkflowGraphNode = {
  laneID: string
  ordinal: number
  label: string
  status: string
  selected: boolean
  attention: boolean
  blocked: boolean
  checking: boolean
  marker: string
}

export type IcWorkflowGraphEdge = {
  fromLaneID: string
  toLaneID: string
  label: string
}

export type IcSelectedLaneSummary = {
  laneID: string
  title: string
  status: string
  whyNow: string
  roleHint: string
  blockerCount: number
  artifactCount: number
  checkSummary: string
}

export type IcLaneBoardRow = {
  laneID: string
  ordinal: number
  label: string
  statusLabel: string
  phase: IcLanePhase
  tone: IcLaneBoardTone
  depth: number
  branch: "root" | "mid" | "last" | "leaf"
  needs: string[]
  selected: boolean
  attention?: "blocked" | "pending-message" | "check-result"
  lastEventPreview?: string
}

export type IcLaneBoardView = {
  workflowID?: string
  summary: {
    total: number
    done: number
    active: number
    checking: number
    pending: number
    blocked: number
    open: number
    waived: number
    unknown: number
  }
  rows: IcLaneBoardRow[]
  selectedLaneID?: string
  nextAttentionLaneID?: string
}

export type IcArtifactSummary = {
  id: string
  workflowID?: string
  producedByLaneID?: string
  kind: string
  title: string
  path: string
  locatorRef?: string
  version?: number
  status?: string
  snapshotError?: string
  detail: string
  mtime: number
  selected?: boolean
}

export type IcTranscriptItem = {
  id: string
  role: "user" | "assistant"
  agent: string
  text: string
  active: boolean
}

export type IcCockpitSummary = {
  counts: {
    lanes: number
    agents: number
    sessions: number
    diagnostics: number
    attention: number
    evidence: number
  }
  laneStatus: Array<{
    status: string
    count: number
  }>
}

export type IcAttentionItem = {
  id: string
  severity: "warn" | "error"
  title: string
  detail: string
  source: string
  laneID?: string
}

export type IcTuiViewModel = {
  surfaceLevel: "single_agent" | "workflow_hint" | "workflow_active" | "multi_agent_active" | "workflow_attention"
  focus: IcFocus | null
  focusSessionID: string
  workflow: {
    active: boolean
    title: string
    detail: string
  }
  lanes: IcLaneSummary[]
  laneBoard: IcLaneBoardView
  sessions: IcSessionSummary[]
  agents: IcAgentSummary[]
  artifacts: IcArtifactSummary[]
  resourceBlocks: IcResourceBlock[]
  diagnostics: IcDiagnostic[]
  attention: IcAttentionItem[]
  transcript: IcTranscriptItem[]
  cockpit: IcCockpitSummary
  graph: {
    nodes: IcWorkflowGraphNode[]
    edges: IcWorkflowGraphEdge[]
    selected?: IcSelectedLaneSummary
    nextAttentionLaneID?: string
  }
}

export type IcSessionMode = "new" | "continue" | "resume"

export function projectIcTui(input: {
  sessions: Session[]
  messages: Record<string, Message[]>
  parts: Record<string, Part[]>
  statuses: Record<string, SessionStatus>
  selectedSessionID?: string
  sessionMode?: IcSessionMode
  selectedLaneID?: string
  selectedLaneRole?: IcLaneRole
  selectedArtifactID?: string
  debugView?: boolean
  workflow?: IcWorkflowSnapshot
}): IcTuiViewModel {
  const primarySessions = input.sessions
    .filter((session) => !session.parentID)
    .toSorted((left, right) => right.time.updated - left.time.updated)
  const allSessions = input.sessions.toSorted((left, right) => right.time.updated - left.time.updated)
  const hasWorkflowState = Boolean(input.workflow?.workflow)
    || Boolean(input.workflow?.lanes.length)
    || Boolean(input.workflow?.agents.length)
  const explicitLane = input.workflow?.lanes.find((lane) => lane.id === input.selectedLaneID)
  const debugLaneFocus = input.debugView && input.selectedSessionID
    ? findLaneRoleForSession(input.workflow, input.selectedSessionID)
    : undefined
  const requestedLane = explicitLane ?? debugLaneFocus?.lane
  const requestedLaneRole = explicitLane ? input.selectedLaneRole : debugLaneFocus?.role
  const requestedArtifact = input.workflow?.artifacts.find((artifact) => artifact.id === input.selectedArtifactID)
  const resolvedSessionID = resolveSelectedSessionID({
    requestedSessionID: input.selectedSessionID,
    sessionMode: input.sessionMode,
    workflow: input.workflow,
    sessions: allSessions,
    debugView: input.debugView,
  })
  const baseSummaries = summarizeSessions({
    sessions: allSessions,
    primarySessions,
    workflow: input.workflow,
    messages: input.messages,
    statuses: input.statuses,
    selectedSessionID: resolvedSessionID,
  })
  const baseAgents = summarizeAgents(input.workflow, baseSummaries, input.statuses, resolvedSessionID)
  const rawDiagnostics = [...(input.workflow?.diagnostics ?? []), ...deriveDiagnostics(baseSummaries, baseAgents.length > 0)]
  const selectedSessionID = resolvedSessionID
  const selectedSession = allSessions.find((session) => session.id === selectedSessionID)
  const selectedWorkflowAgent = input.workflow?.agents.find((agent) => agent.sessionID === selectedSessionID)
  const lanes = (input.workflow?.lanes ?? []).map((lane) =>
    summarizeLane({
      lane,
      workflow: input.workflow,
      statuses: input.statuses,
      selected: lane.id === requestedLane?.id,
      focusedRole: input.debugView ? requestedLaneRole : undefined,
    }),
  )
  const summaries = selectedSessionID === resolvedSessionID
    ? baseSummaries
    : summarizeSessions({
        sessions: allSessions,
        primarySessions,
        workflow: input.workflow,
        messages: input.messages,
        statuses: input.statuses,
        selectedSessionID,
      })
  const agents = selectedSessionID === resolvedSessionID
    ? baseAgents
    : summarizeAgents(input.workflow, summaries, input.statuses, selectedSessionID)
  const diagnostics = rawDiagnostics.map((item) => ({
    ...item,
    selected: item.targetType === "lane" && item.targetID === requestedLane?.id ? true : undefined,
  }))
  const artifacts = (input.workflow?.artifacts ?? []).map((item) => ({
    ...item,
    selected: item.id === requestedArtifact?.id ? true : undefined,
  }))
  const attention = summarizeAttention({
    lanes,
    diagnostics,
    resourceBlocks: input.workflow?.resourceBlocks ?? [],
  })
  const hasAgentRoles = agents.some((agent) => agent.role !== "orchestrator")
  const active = hasWorkflowState || primarySessions.length > 0
  const allocationSummary = input.workflow && (
    (input.workflow.functionSlots?.length ?? 0) > 0 ||
    (input.workflow.inboxItems?.length ?? 0) > 0 ||
    (input.workflow.deliveryFences?.length ?? 0) > 0
  )
    ? ` · ${input.workflow.functionSlots?.length ?? 0} slots` +
      ` · ${input.workflow.inboxItems?.filter((item) => item.status === "QUEUED").length ?? 0} queued` +
      ` · ${input.workflow.deliveryFences?.length ?? 0} fences`
    : ""
  const surfaceLevel = attention.length > 0
    ? "workflow_attention"
    : hasAgentRoles
      ? "multi_agent_active"
      : input.workflow?.lanes.length
        ? "workflow_active"
        : hasWorkflowState
        ? "workflow_hint"
        : "single_agent"

  return {
    surfaceLevel,
    focus: requestedLane
      ? focusForLane(requestedLane, selectedSessionID, input.debugView ? requestedLaneRole : undefined)
      : selectedSession
        ? focusForSession(selectedSession)
        : selectedWorkflowAgent
          ? focusForWorkflowAgent(selectedWorkflowAgent)
          : null,
    focusSessionID: selectedSession?.id || selectedWorkflowAgent?.sessionID || selectedSessionID,
    workflow: {
      active,
      title: input.workflow?.workflow
        ? `${input.workflow.workflow.status} workflow`
        : active ? "IC Agent workspace" : "No workflow loaded",
      detail: input.workflow?.workflow
        ? `${clip(input.workflow.workflow.goal, 180)}${allocationSummary}`
        : active
        ? `${primarySessions.length} session${primarySessions.length === 1 ? "" : "s"} available`
        : "Start or resume an orchestrator session to begin.",
    },
    lanes,
    laneBoard: summarizeLaneBoard({
      workflowID: input.workflow?.workflow?.id,
      lanes,
      selectedLaneID: requestedLane?.id,
    }),
    sessions: summaries,
    agents,
    artifacts,
    resourceBlocks: input.workflow?.resourceBlocks ?? [],
    diagnostics,
    attention,
    transcript: selectedSession ? transcriptForSession(selectedSession.id, input.messages, input.parts) : [],
    cockpit: summarizeCockpit({
      lanes,
      agents,
      sessions: summaries,
      diagnostics,
      attention,
      artifacts,
    }),
    graph: summarizeWorkflowGraph({
      lanes,
      diagnostics,
      artifacts,
      selectedLaneID: requestedLane?.id,
    }),
  }
}

function summarizeLaneBoard(input: {
  workflowID?: string
  lanes: IcLaneSummary[]
  selectedLaneID?: string
}): IcLaneBoardView {
  const attentionLane = input.lanes.find(laneNeedsAttentionForGraph)
  const selectedLane = input.lanes.find((lane) => lane.id === input.selectedLaneID)
  const ordinals = new Map(input.lanes.map((lane, index) => [lane.id, index + 1]))
  const laneIDs = new Set(input.lanes.map((lane) => lane.id))
  const rows: IcLaneBoardRow[] = input.lanes.map((lane, index) => {
    const dependencies = validLaneDependencies(lane, laneIDs)
    return {
      laneID: lane.id,
      ordinal: index + 1,
      label: lane.name || lane.id,
      statusLabel: lane.displayStatus,
      phase: lane.phase,
      tone: laneBoardTone(lane),
      depth: 0,
      branch: "root",
      needs: dependencies.map((id) => pad2(ordinals.get(id) ?? 0)),
      selected: lane.id === selectedLane?.id,
      attention: laneBoardAttention(lane),
      lastEventPreview: lane.updatedAt ? `updated ${lane.updatedAt}` : undefined,
    }
  })

  return {
    workflowID: input.workflowID,
    summary: {
      total: input.lanes.length,
      done: input.lanes.filter(laneDone).length,
      active: input.lanes.filter(laneActive).length,
      checking: input.lanes.filter(laneChecking).length,
      pending: input.lanes.filter((lane) => lane.phase === "pending").length,
      blocked: input.lanes.filter(laneBlocked).length,
      open: input.lanes.filter(laneOpen).length,
      waived: input.lanes.filter((lane) => lane.status === "WAIVED").length,
      unknown: input.lanes.filter((lane) => lane.phase === "unknown").length,
    },
    rows,
    selectedLaneID: selectedLane?.id,
    nextAttentionLaneID: attentionLane?.id,
  }
}

function validLaneDependencies(lane: IcLaneSummary, laneIDs: Set<string>) {
  return (lane.dependsOnLaneIDs ?? []).filter((id) => laneIDs.has(id) && id !== lane.id)
}

function laneBoardTone(lane: IcLaneSummary): IcLaneBoardTone {
  if (lane.resourceBlock) return "blocked"
  return lane.tone
}

function laneBoardAttention(lane: IcLaneSummary): IcLaneBoardRow["attention"] {
  if (laneBlocked(lane)) return "blocked"
  if (lane.phase === "pending") return "pending-message"
  if (lane.lastCheckResult && !laneCheckClean(lane.lastCheckResult)) return "check-result"
  return undefined
}

function summarizeLane(input: {
  lane: IcWorkflowSnapshot["lanes"][number]
  workflow?: IcWorkflowSnapshot
  statuses: Record<string, SessionStatus>
  selected: boolean
  focusedRole?: IcLaneRole
}): IcLaneSummary {
  const recommendedRole = recommendedLaneRole(input.lane)
  const focusedRole = input.selected ? input.focusedRole : undefined
  const resourceBlock = (input.workflow?.resourceBlocks ?? []).find((block) => block.laneID === input.lane.id)
  const presentation = lanePresentation(input.lane.status)
  return {
    ...input.lane,
    resourceBlock,
    phase: presentation.phase,
    displayStatus: presentation.label,
    tone: resourceBlock ? "blocked" : presentation.tone,
    actionability: resourceBlock ? "human" : presentation.actionability,
    terminal: presentation.terminal,
    recommendedRole,
    focusedRole,
    coordinator: laneRoleEntry({
      role: "coordinator",
      sessionID: input.lane.coordinatorSessionID,
      selected: focusedRole === "coordinator",
      recommended: recommendedRole === "coordinator",
      workflow: input.workflow,
      statuses: input.statuses,
    }),
    checker: laneRoleEntry({
      role: "checker",
      sessionID: input.lane.checkerSessionID,
      selected: focusedRole === "checker",
      recommended: recommendedRole === "checker",
      workflow: input.workflow,
      statuses: input.statuses,
    }),
    selected: input.selected,
  }
}

function laneRoleEntry(input: {
  role: Exclude<IcLaneRole, "orchestrator">
  sessionID?: string
  selected: boolean
  recommended: boolean
  workflow?: IcWorkflowSnapshot
  statuses: Record<string, SessionStatus>
}): IcLaneRoleEntry {
  const agent = input.workflow?.agents.find((item) => item.sessionID === input.sessionID)
  return {
    role: input.role,
    label: input.role === "coordinator" ? "C" : "K",
    sessionID: input.sessionID,
    status: input.sessionID ? statusName(input.statuses[input.sessionID], agent?.status) : "unknown",
    selected: input.selected,
    available: Boolean(input.sessionID),
    recommended: input.recommended,
  }
}

function summarizeCockpit(input: {
  lanes: IcLaneSummary[]
  agents: IcAgentSummary[]
  sessions: IcSessionSummary[]
  diagnostics: IcDiagnostic[]
  attention: IcAttentionItem[]
  artifacts: IcArtifactSummary[]
}): IcCockpitSummary {
  const laneStatus = new Map<string, number>()
  input.lanes.forEach((lane) => {
    laneStatus.set(lane.status, (laneStatus.get(lane.status) ?? 0) + 1)
  })
  return {
    counts: {
      lanes: input.lanes.length,
      agents: input.agents.length,
      sessions: input.sessions.length,
      diagnostics: input.diagnostics.length,
      attention: input.attention.length,
      evidence: input.artifacts.length,
    },
    laneStatus: [...laneStatus.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status)),
  }
}

function summarizeAttention(input: {
  lanes: IcLaneSummary[]
  diagnostics: IcDiagnostic[]
  resourceBlocks: IcResourceBlock[]
}): IcAttentionItem[] {
  const items: IcAttentionItem[] = input.diagnostics.flatMap((diagnostic): IcAttentionItem[] => diagnostic.severity === "info" ? [] : [{
      id: `diagnostic:${diagnostic.id}`,
      severity: diagnostic.severity,
      title: diagnostic.title,
      detail: diagnostic.detail,
      source: diagnostic.source,
      laneID: diagnostic.targetType === "lane" ? diagnostic.targetID : undefined,
    }])
  const laneIDs = new Set(items.flatMap((item) => item.laneID ? [item.laneID] : []))
  input.lanes.forEach((lane) => {
    if (laneIDs.has(lane.id)) return
    if (lane.resourceBlock) {
      items.push({
        id: `resource:${lane.resourceBlock.id}`,
        severity: "error",
        title: `Resource blocked: ${lane.name}`,
        detail: lane.resourceBlock.errorMessage ?? lane.resourceBlock.impactSummary ?? "Provider access must be restored before resume.",
        source: "workflow.resource",
        laneID: lane.id,
      })
      laneIDs.add(lane.id)
      return
    }
    if (lane.phase === "blocked" || lane.phase === "pending" || lane.phase === "unknown") {
      items.push({
        id: `lane:${lane.id}:${lane.phase}`,
        severity: lane.phase === "blocked" || lane.phase === "unknown" ? "error" : "warn",
        title: lane.phase === "pending" ? `Decision needed: ${lane.name}` : `${lane.displayStatus}: ${lane.name}`,
        detail: lane.pendingCheckSummary ?? lane.lastCheckResult ?? "Inspect the lane before continuing.",
        source: "workflow.lane",
        laneID: lane.id,
      })
      laneIDs.add(lane.id)
      return
    }
    if (lane.lastCheckResult && !laneCheckClean(lane.lastCheckResult)) {
      items.push({
        id: `lane:${lane.id}:check-result`,
        severity: "warn",
        title: `Check result: ${lane.name}`,
        detail: lane.lastCheckResult,
        source: "workflow.check",
        laneID: lane.id,
      })
    }
  })
  input.resourceBlocks.forEach((block) => {
    if (block.laneID && laneIDs.has(block.laneID)) return
    if (items.some((item) => item.id === `resource:${block.id}`)) return
    items.push({
      id: `resource:${block.id}`,
      severity: "error",
      title: block.laneName ? `Resource blocked: ${block.laneName}` : "Workflow resource blocked",
      detail: block.errorMessage ?? block.impactSummary ?? "Provider access must be restored before resume.",
      source: "workflow.resource",
      laneID: block.laneID,
    })
  })
  return items.toSorted((left, right) => severityRank(right.severity) - severityRank(left.severity))
}

function severityRank(severity: IcAttentionItem["severity"]) {
  return severity === "error" ? 2 : 1
}

function summarizeWorkflowGraph(input: {
  lanes: IcLaneSummary[]
  diagnostics: IcDiagnostic[]
  artifacts: IcArtifactSummary[]
  selectedLaneID?: string
}): IcTuiViewModel["graph"] {
  const attentionLane = input.lanes.find(laneNeedsAttentionForGraph)
  const selectedLane = input.lanes.find((lane) => lane.id === input.selectedLaneID)
    ?? attentionLane
    ?? input.lanes[0]
  const nodes = input.lanes.map((lane, index) => {
    const blocked = laneBlocked(lane)
    const checking = laneChecking(lane)
    const attention = laneNeedsAttentionForGraph(lane)
    return {
      laneID: lane.id,
      ordinal: index + 1,
      label: lane.name || lane.id,
      status: lane.status,
      selected: lane.id === selectedLane?.id,
      attention,
      blocked,
      checking,
      marker: blocked ? "!" : checking ? "K" : attention ? "*" : laneDone(lane) ? "✓" : "·",
    }
  })
  const laneIDs = new Set(input.lanes.map((lane) => lane.id))
  const dependencyEdges = input.lanes.flatMap((lane) =>
    (lane.dependsOnLaneIDs ?? [])
      .filter((dependencyID) => laneIDs.has(dependencyID) && dependencyID !== lane.id)
      .map((dependencyID) => ({
        fromLaneID: dependencyID,
        toLaneID: lane.id,
        label: "depends",
      })),
  )
  const edges = dependencyEdges.length > 0
    ? uniqueGraphEdges(dependencyEdges)
    : input.lanes.slice(1).map((lane, index) => ({
        fromLaneID: input.lanes[index]!.id,
        toLaneID: lane.id,
        label: "then",
      }))
  return {
    nodes,
    edges,
    selected: selectedLane
      ? {
          laneID: selectedLane.id,
          title: selectedLane.name || selectedLane.id,
          status: selectedLane.status,
          whyNow: laneWhyNow(selectedLane),
          roleHint: `detail opens ${roleLabelForProjection(selectedLane.recommendedRole)}`,
          blockerCount: laneDiagnosticCount(input.diagnostics, selectedLane),
          artifactCount: laneArtifactCount(input.artifacts, selectedLane),
          checkSummary: laneCheckSummary(selectedLane),
        }
      : undefined,
    nextAttentionLaneID: attentionLane?.id,
  }
}

function uniqueGraphEdges(edges: IcWorkflowGraphEdge[]) {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.fromLaneID}\u0000${edge.toLaneID}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function laneNeedsAttentionForGraph(lane: IcLaneSummary) {
  return Boolean(lane.resourceBlock)
    || lane.actionability !== "none"
    || Boolean(lane.lastCheckResult && !laneCheckClean(lane.lastCheckResult))
}

function laneBlocked(lane: IcLaneSummary) {
  return Boolean(lane.resourceBlock)
    || lane.phase === "blocked"
}

function laneChecking(lane: IcLaneSummary) {
  return lane.phase === "checking"
}

function laneDone(lane: IcLaneSummary) {
  return lane.terminal
}

function laneActive(lane: IcLaneSummary) {
  return lane.phase === "active"
}

function laneOpen(lane: IcLaneSummary) {
  return lane.phase === "open"
}

function laneCheckClean(result: string) {
  return ["pass", "passed", "done", "ok", "clean"].includes(result.trim().toLowerCase())
}

function laneWhyNow(lane: IcLaneSummary) {
  if (lane.resourceBlock) return "LLM quota or provider resource is blocked"
  if (lane.phase === "pending") return lane.pendingCheckSummary || "Orchestrator or human decision required"
  if (laneBlocked(lane)) return "blocking downstream workflow progress"
  if (laneChecking(lane)) return "waiting for checker or signoff attention"
  if (lane.lastCheckResult && !laneCheckClean(lane.lastCheckResult)) return `last check ${lane.lastCheckResult}`
  if (laneDone(lane)) return "completed or clean"
  if (lane.phase === "unknown") return `unknown lane state ${lane.status}`
  return "next visible workflow lane"
}

function laneCheckSummary(lane: IcLaneSummary) {
  const parts = []
  if (lane.resourceBlock) parts.push("resource blocked")
  if (lane.lastCheckResult) parts.push(`check ${lane.lastCheckResult}`)
  if (lane.reopenCount) parts.push(`reopen ${lane.reopenCount}`)
  if (lane.repairCycle) parts.push(`repair ${lane.repairCycle}`)
  return parts.join(" · ") || "no check result"
}

function laneDiagnosticCount(diagnostics: IcDiagnostic[], lane: IcLaneSummary) {
  return diagnostics.filter((item) => item.targetType === "lane" && item.targetID === lane.id).length
}

function laneArtifactCount(artifacts: IcArtifactSummary[], lane: IcLaneSummary) {
  const needles = [lane.id, lane.name].map((item) => item.toLowerCase()).filter(Boolean)
  return artifacts.filter((item) => {
    const haystack = `${item.id} ${item.title} ${item.path} ${item.detail}`.toLowerCase()
    return needles.some((needle) => haystack.includes(needle))
  }).length
}

function roleLabelForProjection(role: IcLaneRole) {
  if (role === "coordinator") return "coordinator"
  if (role === "checker") return "checker"
  return "orchestrator"
}

function pad2(value: number) {
  return value.toString().padStart(2, "0")
}

function summarizeAgents(
  workflow: IcWorkflowSnapshot | undefined,
  summaries: IcSessionSummary[],
  statuses: Record<string, SessionStatus>,
  selectedSessionID: string,
): IcAgentSummary[] {
  return workflow?.agents.length
    ? workflow.agents.map((agent) => ({
        id: agent.instanceID,
        role: agent.role,
        sessionID: agent.sessionID,
        laneIDs: agent.laneIDs,
        status: statusName(statuses[agent.sessionID], agent.status),
        title: agent.instanceID,
        selected: agent.sessionID === selectedSessionID,
      }))
    : summaries.map((session) => ({
        id: `agent:${session.id}`,
        role: session.role,
        sessionID: session.id,
        laneIDs: [],
        status: session.status,
        title: session.title,
        selected: session.id === selectedSessionID,
      }))
}

function summarizeSessions(input: {
  sessions: Session[]
  primarySessions: Session[]
  workflow?: IcWorkflowSnapshot
  messages: Record<string, Message[]>
  statuses: Record<string, SessionStatus>
  selectedSessionID: string
}): IcSessionSummary[] {
  const byID = new Map(input.sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  const summaries: IcSessionSummary[] = []
  const pushSession = (session: Session) => {
    if (seen.has(session.id)) return
    seen.add(session.id)
    summaries.push(summarizeSession(session, input.messages, input.statuses, input.selectedSessionID))
  }
  const hasWorkflowBindings = Boolean(input.workflow?.agents.length)
  if (!hasWorkflowBindings) input.primarySessions.forEach(pushSession)
  if (hasWorkflowBindings && input.selectedSessionID) {
    const selectedSession = byID.get(input.selectedSessionID)
    if (selectedSession) pushSession(selectedSession)
  }
  input.workflow?.agents.forEach((agent) => {
    const session = byID.get(agent.sessionID)
    if (session) {
      pushSession(session)
      return
    }
    if (seen.has(agent.sessionID)) return
    seen.add(agent.sessionID)
    summaries.push({
      id: agent.sessionID,
      title: agent.instanceID,
      role: agent.role,
      status: statusName(input.statuses[agent.sessionID], agent.status),
      updated: 0,
      messageCount: input.messages[agent.sessionID]?.length ?? 0,
      selected: agent.sessionID === input.selectedSessionID,
    })
  })
  if (!hasWorkflowBindings && input.selectedSessionID) {
    const selectedSession = byID.get(input.selectedSessionID)
    if (selectedSession) pushSession(selectedSession)
  }
  if (hasWorkflowBindings && summaries.length === 0) input.primarySessions.slice(0, 1).forEach(pushSession)
  return summaries
}

function recommendedLaneRole(lane: IcWorkflowSnapshot["lanes"][number]): IcLaneRole {
  const result = lane.lastCheckResult?.trim().toLowerCase()
  const presentation = lanePresentation(lane.status)
  const resultNeedsChecker = Boolean(result && !["pass", "passed", "done", "ok", "clean"].includes(result))
  const statusNeedsChecker = presentation.phase === "checking"
  const hasPendingCheck = Boolean(lane.pendingCheckSummary?.trim())
  if (lane.checkerSessionID && (statusNeedsChecker || resultNeedsChecker || hasPendingCheck)) return "checker"
  if (lane.coordinatorSessionID) return "coordinator"
  if (lane.checkerSessionID) return "checker"
  return "orchestrator"
}

function resolveSelectedSessionID(input: {
  requestedSessionID?: string
  sessionMode?: IcSessionMode
  workflow?: IcWorkflowSnapshot
  sessions: Session[]
  debugView?: boolean
}) {
  const hasWorkflowState = Boolean(input.workflow?.workflow)
    || Boolean(input.workflow?.lanes.length)
    || Boolean(input.workflow?.agents.length)
  if (hasWorkflowState) {
    if (input.debugView && input.requestedSessionID && isKnownDebugSession(input.requestedSessionID, input.sessions, input.workflow)) {
      return input.requestedSessionID
    }
    return findOrchestratorAgent(input.workflow)?.sessionID
      || findOrchestrator(input.sessions)?.id
      || ""
  }
  if (input.sessionMode === "new" && !input.requestedSessionID) return ""
  if (input.requestedSessionID) {
    const requested = input.sessions.find((session) => session.id === input.requestedSessionID)
    if (input.debugView && requested) return input.requestedSessionID
    if (!requested || roleFromSession(requested) === "orchestrator") return input.requestedSessionID
  }
  return findOrchestratorAgent(input.workflow)?.sessionID
    || findOrchestrator(input.sessions)?.id
    || ""
}

function isKnownDebugSession(sessionID: string, sessions: Session[], workflow?: IcWorkflowSnapshot) {
  return sessions.some((session) => session.id === sessionID)
    || Boolean(workflow?.agents.some((agent) => agent.sessionID === sessionID))
    || Boolean(findLaneRoleForSession(workflow, sessionID))
}

function findLaneRoleForSession(workflow: IcWorkflowSnapshot | undefined, sessionID: string) {
  for (const lane of workflow?.lanes ?? []) {
    if (lane.coordinatorSessionID === sessionID) return { lane, role: "coordinator" as const }
    if (lane.checkerSessionID === sessionID) return { lane, role: "checker" as const }
  }
  return undefined
}

function summarizeSession(
  session: Session,
  messages: Record<string, Message[]>,
  statuses: Record<string, SessionStatus>,
  selectedSessionID: string,
): IcSessionSummary {
  return {
    id: session.id,
    title: session.title || short(session.id),
    role: roleFromSession(session),
    status: statusName(statuses[session.id]),
    updated: session.time.updated,
    messageCount: messages[session.id]?.length ?? 0,
    selected: session.id === selectedSessionID,
  }
}

function focusForSession(session: Session): IcFocus {
  const role = roleFromSession(session)
  if (role === "orchestrator") {
    return {
      type: "orchestrator",
      sessionID: session.id,
    }
  }
  return {
    type: "agent",
    agentID: `agent:${session.id}`,
    role,
    sessionID: session.id,
  }
}

function focusForLane(lane: IcWorkflowSnapshot["lanes"][number], sessionID: string, laneRole: IcLaneRole = "orchestrator"): IcFocus {
  return {
    type: "lane",
    laneID: lane.id,
    name: lane.name,
    status: lane.status,
    sessionID: sessionID || undefined,
    laneRole,
  }
}

function focusForWorkflowAgent(agent: NonNullable<IcWorkflowSnapshot["agents"][number]>): IcFocus {
  if (agent.role === "orchestrator") {
    return {
      type: "orchestrator",
      sessionID: agent.sessionID,
    }
  }
  return {
    type: "agent",
    agentID: agent.instanceID,
    role: agent.role,
    sessionID: agent.sessionID,
  }
}

function deriveDiagnostics(sessions: IcSessionSummary[], hasWorkflowAgents = false): IcDiagnostic[] {
  const diagnostics: IcDiagnostic[] = []
  const retry = sessions.filter((session) => session.status === "retry")
  retry.forEach((session) => {
    diagnostics.push({
      id: `retry:${session.id}`,
      severity: "error",
      title: `${session.role} retry`,
      detail: session.title,
      source: "opencode.session.status",
      targetType: "session",
      targetID: session.id,
      recommendation: "Open the focused session and inspect the retry action before submitting more prompts.",
      evidence: session.title,
      readonly: true,
      sessionID: session.id,
    })
  })
  const busy = sessions.filter((session) => session.status === "busy")
  if (busy.length > 0) {
    diagnostics.push({
      id: "busy",
      severity: "info",
      title: `${busy.length} active session${busy.length === 1 ? "" : "s"}`,
      detail: busy.map((session) => session.role).join(", "),
      source: "opencode.session.status",
      targetType: "session",
      targetID: busy[0]?.id ?? "unknown",
      recommendation: "Wait for the active session to become idle before sending intervention prompts.",
      evidence: busy.map((session) => `${session.role}:${session.id}`).join(", "),
      readonly: true,
      sessionID: busy[0]?.id,
    })
  }
  if (sessions.length === 0 && !hasWorkflowAgents) {
    diagnostics.push({
      id: "no-session",
      severity: "warn",
      title: "No OpenCode session",
      detail: "IC shell is ready, but no orchestrator session is available yet.",
      source: "opencode.session.list",
      targetType: "runtime",
      targetID: "opencode",
      recommendation: "Start or resume an orchestrator session in this workspace.",
      evidence: "No top-level OpenCode sessions were present in the current sync snapshot.",
      readonly: true,
    })
  }
  return diagnostics
}

function transcriptForSession(
  sessionID: string,
  messages: Record<string, Message[]>,
  parts: Record<string, Part[]>,
): IcTranscriptItem[] {
  return (messages[sessionID] ?? []).slice(-8).map((message) => {
    const messageParts = parts[message.id] ?? []
    const text = messageParts
      .flatMap((part) => {
        if (part.type === "text" && !part.synthetic && !part.ignored) return [part.text]
        if (part.type === "reasoning") return [part.text]
        if (part.type === "tool") return [`tool:${part.tool} ${part.state.status}`]
        return []
      })
      .join("\n")
      .trim()
    return {
      id: message.id,
      role: message.role,
      agent: message.role === "user" ? message.agent : message.mode,
      text: text || "(no visible text)",
      active: message.role === "assistant" && !message.time.completed,
    }
  })
}

function roleFromSession(session: Session) {
  const text = `${session.title} ${session.id}`.toLowerCase()
  if (text.includes("checker")) return "checker"
  if (text.includes("coordinator") || text.includes("coord")) return "coordinator"
  if (text.includes("analyst")) return "analyst"
  if (text.includes("orchestrator")) return "orchestrator"
  return "orchestrator"
}

function findOrchestrator(sessions: Session[]) {
  return sessions.find((session) => roleFromSession(session) === "orchestrator")
}

function statusName(status?: SessionStatus, fallback?: string): IcSessionSummary["status"] {
  if (!status && fallback?.toLowerCase() === "alive") return "idle"
  if (!status && fallback?.toLowerCase() === "busy") return "busy"
  if (!status) return "unknown"
  if (status.type === "busy") return "busy"
  if (status.type === "retry") return "retry"
  return "idle"
}

function findOrchestratorAgent(workflow?: IcWorkflowSnapshot) {
  return workflow?.agents.find((agent) => agent.role === "orchestrator" && agent.sessionID)
}

function short(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...`
}

function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`
}
