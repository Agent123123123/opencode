export const IC_LANE_STATES = [
  "OPEN",
  "READY",
  "WORKING",
  "AWAITING_CHECK",
  "CHECKING",
  "PENDING",
  "BLOCKED",
  "DONE",
  "WAIVED",
] as const

export type IcLaneState = (typeof IC_LANE_STATES)[number]
export type IcLanePhase = "open" | "active" | "checking" | "pending" | "blocked" | "terminal" | "unknown"
export type IcLaneActionability = "none" | "inspect" | "human" | "error"
export type IcLaneBoardTone = "done" | "waived" | "active" | "blocked" | "checking" | "pending" | "open" | "unknown"
export type IcLaneSummaryBucket = "done" | "active" | "checking" | "pending" | "blocked" | "open" | "unknown"

export type IcLanePresentation = {
  state?: IcLaneState
  label: string
  phase: IcLanePhase
  tone: IcLaneBoardTone
  bucket: IcLaneSummaryBucket
  actionability: IcLaneActionability
  terminal: boolean
}

const PRESENTATION: Record<IcLaneState, IcLanePresentation> = {
  OPEN: {
    state: "OPEN",
    label: "open",
    phase: "open",
    tone: "open",
    bucket: "open",
    actionability: "none",
    terminal: false,
  },
  READY: {
    state: "READY",
    label: "ready · waiting for slot",
    phase: "open",
    tone: "open",
    bucket: "open",
    actionability: "none",
    terminal: false,
  },
  WORKING: {
    state: "WORKING",
    label: "active",
    phase: "active",
    tone: "active",
    bucket: "active",
    actionability: "none",
    terminal: false,
  },
  AWAITING_CHECK: {
    state: "AWAITING_CHECK",
    label: "awaiting check",
    phase: "checking",
    tone: "checking",
    bucket: "checking",
    actionability: "none",
    terminal: false,
  },
  CHECKING: {
    state: "CHECKING",
    label: "checking",
    phase: "checking",
    tone: "checking",
    bucket: "checking",
    actionability: "none",
    terminal: false,
  },
  PENDING: {
    state: "PENDING",
    label: "needs decision",
    phase: "pending",
    tone: "pending",
    bucket: "pending",
    actionability: "human",
    terminal: false,
  },
  BLOCKED: {
    state: "BLOCKED",
    label: "blocked",
    phase: "blocked",
    tone: "blocked",
    bucket: "blocked",
    actionability: "error",
    terminal: false,
  },
  DONE: {
    state: "DONE",
    label: "done",
    phase: "terminal",
    tone: "done",
    bucket: "done",
    actionability: "none",
    terminal: true,
  },
  WAIVED: {
    state: "WAIVED",
    label: "waived",
    phase: "terminal",
    tone: "waived",
    bucket: "done",
    actionability: "none",
    terminal: true,
  },
}

const UNKNOWN: IcLanePresentation = {
  label: "unknown",
  phase: "unknown",
  tone: "unknown",
  bucket: "unknown",
  actionability: "inspect",
  terminal: false,
}

export function lanePresentation(status: string): IcLanePresentation {
  const state = status.trim().toUpperCase()
  if (!isIcLaneState(state)) return UNKNOWN
  return PRESENTATION[state]
}

export function isIcLaneState(value: string): value is IcLaneState {
  return (IC_LANE_STATES as readonly string[]).includes(value)
}
