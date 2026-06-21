import type { IcLaneRole, IcTuiViewModel } from "./projection"

export type IcSidecardMode = "workflow" | "detail" | "debug"

export type IcCommandID =
  | "ic.orchestrator.focus"
  | "ic.orchestrator.sessions"
  | "ic.workflow.refresh"
  | "ic.workflow.focus"
  | "ic.lane.focus"
  | "ic.debug.coordinator"
  | "ic.debug.checker"

export type IcCommandIntent =
  | { type: "start-orchestrator" }
  | { type: "open-sessions" }
  | { type: "refresh-workflow" }
  | { type: "sidecard"; mode: IcSidecardMode }
  | { type: "focus-lane"; laneID: string }
  | { type: "focus-lane-role"; laneID: string; role: Exclude<IcLaneRole, "orchestrator"> }
  | { type: "focus-session"; sessionID: string }

export type IcCommandSpec = {
  id: IcCommandID
  title: string
  description: string
  slashName: string
  slashAliases?: string[]
  category: "Motryx"
  enabled: boolean
  intent: IcCommandIntent
}

export function icCommandSpecs(model: IcTuiViewModel, options?: { debugView?: boolean }): IcCommandSpec[] {
  const firstLane = model.lanes[0]
  const orchestratorSession = findOrchestratorSession(model)
  const debugCoordinatorLane = findDebugLaneForRole(model, "coordinator")
  const debugCheckerLane = findDebugLaneForRole(model, "checker")

  const commands: IcCommandSpec[] = [
    {
      id: "ic.orchestrator.focus",
      title: orchestratorSession ? `Focus orchestrator ${orchestratorSession.title}` : "Start orchestrator session",
      description: orchestratorSession
        ? "Return to the primary Motryx orchestrator conversation."
        : "Create a new Motryx orchestrator conversation.",
      slashName: "orchestrator",
      slashAliases: ["orch"],
      category: "Motryx",
      enabled: true,
      intent: orchestratorSession ? { type: "focus-session", sessionID: orchestratorSession.id } : { type: "start-orchestrator" },
    },
    {
      id: "ic.orchestrator.sessions",
      title: "Resume Motryx orchestrator",
      description: "Choose a project-scoped Motryx orchestrator conversation.",
      slashName: "sessions",
      slashAliases: ["resume", "history"],
      category: "Motryx",
      enabled: true,
      intent: { type: "open-sessions" },
    },
    {
      id: "ic.workflow.refresh",
      title: "Refresh Motryx flow",
      description: "Reload workflow, lane, blocker, and output state from the Motryx adapter.",
      slashName: "refresh",
      slashAliases: ["reload-workflow", "workflow-refresh"],
      category: "Motryx",
      enabled: true,
      intent: { type: "refresh-workflow" },
    },
    {
      id: "ic.workflow.focus",
      title: "Show Motryx flow",
      description: "Open the lane board and selected lane summary.",
      slashName: "workflow",
      slashAliases: ["wf"],
      category: "Motryx",
      enabled: true,
      intent: { type: "sidecard", mode: "workflow" },
    },
    {
      id: "ic.lane.focus",
      title: firstLane ? `Focus lane ${firstLane.name}` : "Show Motryx lanes",
      description: firstLane
        ? "Select the first lane in the lane board without switching the conversation session."
        : "Open the lane board.",
      slashName: "lane",
      slashAliases: ["ic-lane", "ic-lanes"],
      category: "Motryx",
      enabled: true,
      intent: firstLane ? { type: "focus-lane", laneID: firstLane.id } : { type: "sidecard", mode: "workflow" },
    },
  ]
  if (options?.debugView) {
    commands.push(
      {
        id: "ic.debug.coordinator",
        title: debugCoordinatorLane ? `Debug coordinator ${debugCoordinatorLane.name}` : "Debug coordinator",
        description: debugCoordinatorLane
          ? "Focus the coordinator conversation for the selected Motryx lane."
          : "No coordinator session is available for the current lane.",
        slashName: "coordinator",
        slashAliases: ["coord"],
        category: "Motryx",
        enabled: Boolean(debugCoordinatorLane?.coordinator.available),
        intent: debugCoordinatorLane
          ? { type: "focus-lane-role", laneID: debugCoordinatorLane.id, role: "coordinator" }
          : { type: "sidecard", mode: "debug" },
      },
      {
        id: "ic.debug.checker",
        title: debugCheckerLane ? `Debug checker ${debugCheckerLane.name}` : "Debug checker",
        description: debugCheckerLane
          ? "Focus the checker conversation for the selected Motryx lane."
          : "No checker session is available for the current lane.",
        slashName: "checker",
        slashAliases: ["check"],
        category: "Motryx",
        enabled: Boolean(debugCheckerLane?.checker.available),
        intent: debugCheckerLane
          ? { type: "focus-lane-role", laneID: debugCheckerLane.id, role: "checker" }
          : { type: "sidecard", mode: "debug" },
      },
    )
  }
  return commands
}

function findOrchestratorSession(model: IcTuiViewModel) {
  const orchestratorAgent = model.agents.find((agent) => agent.role === "orchestrator" && agent.sessionID)
  if (orchestratorAgent) {
    return model.sessions.find((session) => session.id === orchestratorAgent.sessionID)
      ?? {
        id: orchestratorAgent.sessionID,
        title: orchestratorAgent.title,
        role: "orchestrator",
        status: orchestratorAgent.status,
        updated: 0,
        messageCount: 0,
        selected: orchestratorAgent.selected,
      }
  }
  return model.sessions.find((session) => session.role === "orchestrator")
}

function findDebugLaneForRole(model: IcTuiViewModel, role: Exclude<IcLaneRole, "orchestrator">) {
  const entry = (lane: IcTuiViewModel["lanes"][number]) => role === "coordinator" ? lane.coordinator : lane.checker
  return model.lanes.find((lane) => lane.selected && entry(lane).available)
    ?? model.lanes.find((lane) => entry(lane).available)
}
