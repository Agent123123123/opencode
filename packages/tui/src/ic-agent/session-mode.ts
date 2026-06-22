import type { IcSessionMode } from "./projection"

type MotryxStartupEnv = {
  OPENCODE_ROUTE?: string
  OPENCODE_IC_AGENT_TUI?: string
}

export function startupRouteFromEnv(env: MotryxStartupEnv = process.env as MotryxStartupEnv) {
  if (env.OPENCODE_ROUTE) return JSON.parse(env.OPENCODE_ROUTE) as unknown
  if (env.OPENCODE_IC_AGENT_TUI) return { type: "ic-agent" }
  return undefined
}

export function shouldUseOpenCodeContinueStartupRoute(input: {
  startupRoute: unknown
  continueRequested: boolean
}) {
  return !input.startupRoute && input.continueRequested
}

export function shouldRunOpenCodeContinueNavigation(input: {
  currentRouteType: string
  alreadyContinued: boolean
  syncStatus: string
  continueRequested: boolean
}) {
  return input.currentRouteType !== "ic-agent"
    && !input.alreadyContinued
    && input.syncStatus !== "loading"
    && input.continueRequested
}

export function motryxSessionModeFromEnv(value = process.env.MOTRYX_SESSION_MODE): IcSessionMode {
  if (value === "new" || value === "resume" || value === "continue") return value
  return "continue"
}

export function motryxDebugViewFromEnv(value = process.env.MOTRYX_DEBUG_VIEW): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

export function shouldAutoStartOrchestrator(input: {
  sessionMode: IcSessionMode
  focusSessionID?: string
  startingSession: boolean
  autoStartAttempted: boolean
}) {
  return input.sessionMode === "new"
    && !input.focusSessionID
    && !input.startingSession
    && !input.autoStartAttempted
}
