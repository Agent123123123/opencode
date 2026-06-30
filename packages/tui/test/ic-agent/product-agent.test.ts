import { expect, test } from "bun:test"
import {
  MOTRYX_DEFAULT_AGENT,
  isMotryxHiddenNativeAgent,
  isMotryxProductMode,
  isMotryxVisibleSession,
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

test("keeps only Motryx-visible orchestrator sessions in product lists", () => {
  expect(isMotryxVisibleSession({ agent: "orchestrator", title: "main" })).toBe(true)
  expect(isMotryxVisibleSession({ agent: "checker", title: "lane checker" })).toBe(false)
  expect(isMotryxVisibleSession({ agent: "coordinator", title: "lane coordinator" })).toBe(false)
  expect(isMotryxVisibleSession({ agent: "build", title: "native build" })).toBe(false)
  expect(isMotryxVisibleSession({ title: "legacy orchestrator conversation" })).toBe(true)
  expect(isMotryxVisibleSession({ title: "legacy checker session" })).toBe(false)
})
