import type { IcTuiViewModel } from "./projection"

export type IcSidecardMode = "workflow" | "detail"

export type IcCommandID =
  | "ic.orchestrator.focus"
  | "ic.orchestrator.sessions"
  | "ic.workflow.refresh"
  | "ic.workflow.focus"
  | "ic.lane.focus"

export type IcCommandIntent =
  | { type: "start-orchestrator" }
  | { type: "open-sessions" }
  | { type: "refresh-workflow" }
  | { type: "sidecard"; mode: IcSidecardMode }
  | { type: "focus-lane"; laneID: string }
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

export function icCommandSpecs(model: IcTuiViewModel): IcCommandSpec[] {
  const firstLane = model.lanes[0]
  const firstSession = model.sessions.find((session) => session.selected) ?? model.sessions[0]

  return [
    {
      id: "ic.orchestrator.focus",
      title: firstSession ? `Focus orchestrator ${firstSession.title}` : "Start orchestrator session",
      description: firstSession
        ? "Return to the primary Motryx orchestrator conversation."
        : "Create a new Motryx orchestrator conversation.",
      slashName: "orchestrator",
      slashAliases: ["orch"],
      category: "Motryx",
      enabled: true,
      intent: firstSession ? { type: "focus-session", sessionID: firstSession.id } : { type: "start-orchestrator" },
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
}
