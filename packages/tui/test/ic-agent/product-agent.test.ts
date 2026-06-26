import { expect, test } from "bun:test"
import {
  MOTRYX_DEFAULT_AGENT,
  isMotryxHiddenNativeAgent,
  isMotryxProductMode,
  motryxProductAgentDisplayName,
  motryxProductAgentName,
} from "../../src/ic-agent/product-agent"

test("detects Motryx product mode from launcher environment", () => {
  expect(isMotryxProductMode({ OPENCODE_IC_AGENT_TUI: "1" })).toBe(true)
  expect(isMotryxProductMode({ OPENCODE_IC_AGENT_THEME: "motryx" })).toBe(true)
  expect(isMotryxProductMode({ OPENCODE_IC_AGENT_THEME: "motryx_light" })).toBe(true)
  expect(isMotryxProductMode({ OPENCODE_IC_AGENT_THEME: "motryx_dark" })).toBe(true)
  expect(isMotryxProductMode({ OPENCODE_ROUTE: '{"type":"ic-agent"}' })).toBe(true)
  expect(isMotryxProductMode({ OPENCODE_IC_AGENT_TUI: undefined, OPENCODE_ROUTE: '{"type":"session"}' })).toBe(false)
})

test("maps OpenCode native build and plan agents to Motryx orchestrator", () => {
  expect(isMotryxHiddenNativeAgent("build")).toBe(true)
  expect(isMotryxHiddenNativeAgent("plan")).toBe(true)
  expect(isMotryxHiddenNativeAgent("checker")).toBe(false)
  expect(motryxProductAgentName("build")).toBe(MOTRYX_DEFAULT_AGENT)
  expect(motryxProductAgentName("plan")).toBe(MOTRYX_DEFAULT_AGENT)
  expect(motryxProductAgentDisplayName("checker")).toBe("checker")
})
