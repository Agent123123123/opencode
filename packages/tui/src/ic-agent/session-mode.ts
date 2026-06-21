import type { IcSessionMode } from "./projection"

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
