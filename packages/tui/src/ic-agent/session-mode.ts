import type { IcSessionMode } from "./projection"

export function motryxSessionModeFromEnv(value = process.env.MOTRYX_SESSION_MODE): IcSessionMode {
  if (value === "new" || value === "resume" || value === "continue") return value
  return "continue"
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
