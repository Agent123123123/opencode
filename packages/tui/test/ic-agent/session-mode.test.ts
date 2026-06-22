import { expect, test } from "bun:test"
import {
  motryxDebugViewFromEnv,
  motryxSessionModeFromEnv,
  shouldAutoStartOrchestrator,
  shouldRunOpenCodeContinueNavigation,
  shouldUseOpenCodeContinueStartupRoute,
  startupRouteFromEnv,
} from "../../src/ic-agent/session-mode"

test("parses Motryx route session mode from environment values", () => {
  expect(motryxSessionModeFromEnv("new")).toBe("new")
  expect(motryxSessionModeFromEnv("continue")).toBe("continue")
  expect(motryxSessionModeFromEnv("resume")).toBe("resume")
  expect(motryxSessionModeFromEnv("")).toBe("continue")
  expect(motryxSessionModeFromEnv("checker")).toBe("continue")
})

test("parses internal Motryx debug view from environment values", () => {
  expect(motryxDebugViewFromEnv("1")).toBe(true)
  expect(motryxDebugViewFromEnv("true")).toBe(true)
  expect(motryxDebugViewFromEnv("yes")).toBe(true)
  expect(motryxDebugViewFromEnv("on")).toBe(true)
  expect(motryxDebugViewFromEnv("0")).toBe(false)
  expect(motryxDebugViewFromEnv("false")).toBe(false)
  expect(motryxDebugViewFromEnv("")).toBe(false)
  expect(motryxDebugViewFromEnv(undefined)).toBe(false)
})

test("auto-starts an orchestrator only for a fresh --new route without focus", () => {
  expect(shouldAutoStartOrchestrator({
    sessionMode: "new",
    focusSessionID: "",
    startingSession: false,
    autoStartAttempted: false,
  })).toBe(true)

  expect(shouldAutoStartOrchestrator({
    sessionMode: "continue",
    focusSessionID: "",
    startingSession: false,
    autoStartAttempted: false,
  })).toBe(false)

  expect(shouldAutoStartOrchestrator({
    sessionMode: "resume",
    focusSessionID: "",
    startingSession: false,
    autoStartAttempted: false,
  })).toBe(false)

  expect(shouldAutoStartOrchestrator({
    sessionMode: "new",
    focusSessionID: "ses_existing",
    startingSession: false,
    autoStartAttempted: false,
  })).toBe(false)

  expect(shouldAutoStartOrchestrator({
    sessionMode: "new",
    focusSessionID: "",
    startingSession: true,
    autoStartAttempted: false,
  })).toBe(false)

  expect(shouldAutoStartOrchestrator({
    sessionMode: "new",
    focusSessionID: "",
    startingSession: false,
    autoStartAttempted: true,
  })).toBe(false)
})

test("uses Motryx startup route ahead of OpenCode continue route", () => {
  const startupRoute = startupRouteFromEnv({
    OPENCODE_ROUTE: '{"type":"ic-agent"}',
    OPENCODE_IC_AGENT_TUI: undefined,
  })

  expect(startupRoute).toEqual({ type: "ic-agent" })
  expect(shouldUseOpenCodeContinueStartupRoute({
    startupRoute,
    continueRequested: true,
  })).toBe(false)

  expect(shouldUseOpenCodeContinueStartupRoute({
    startupRoute: undefined,
    continueRequested: true,
  })).toBe(true)
})

test("does not run OpenCode continue navigation from Motryx route", () => {
  expect(shouldRunOpenCodeContinueNavigation({
    currentRouteType: "ic-agent",
    alreadyContinued: false,
    syncStatus: "partial",
    continueRequested: true,
  })).toBe(false)

  expect(shouldRunOpenCodeContinueNavigation({
    currentRouteType: "home",
    alreadyContinued: false,
    syncStatus: "partial",
    continueRequested: true,
  })).toBe(true)
})
