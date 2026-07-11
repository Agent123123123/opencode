import { expect, test } from "bun:test"
import {
  MOTRYX_TERMINAL_ICON,
  MOTRYX_TERMINAL_ICON_COMPACT,
  isMotryxStartupReady,
  motryxStartupLayout,
  shouldShowStartupLoading,
} from "../../src/ic-agent/motryx-startup"

test("keeps terminal icon rows rectangular and paired into terminal cells", () => {
  for (const icon of [MOTRYX_TERMINAL_ICON, MOTRYX_TERMINAL_ICON_COMPACT]) {
    expect(icon.length % 2).toBe(0)
    expect(new Set(icon.map((row) => row.length)).size).toBe(1)
    expect(icon.every((row) => /^[.MmXx]+$/.test(row))).toBe(true)
  }
})

test("selects a startup layout that fits constrained terminals", () => {
  expect(motryxStartupLayout(80, 24)).toBe("standard")
  expect(motryxStartupLayout(40, 12)).toBe("compact")
  expect(motryxStartupLayout(20, 7)).toBe("minimal")
})

test("Motryx loading remains visible even when native fast boot is enabled", () => {
  expect(shouldShowStartupLoading(true, true)).toBe(true)
  expect(shouldShowStartupLoading(false, true)).toBe(false)
  expect(shouldShowStartupLoading(false, false)).toBe(true)
})

test("waits for the usable sync boundary independently of native fast boot policy", () => {
  expect(isMotryxStartupReady(false, "loading")).toBe(false)
  expect(isMotryxStartupReady(true, "loading")).toBe(false)
  expect(isMotryxStartupReady(true, "partial")).toBe(true)
  expect(isMotryxStartupReady(true, "complete")).toBe(true)
})
