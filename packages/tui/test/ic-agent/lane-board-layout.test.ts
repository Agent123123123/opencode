import { expect, test } from "bun:test"
import { laneBoardLayout } from "../../src/ic-agent/lane-board-layout"

test("keeps lane board airy when the terminal has enough vertical room", () => {
  expect(laneBoardLayout({
    terminalHeight: 48,
    laneCount: 8,
    hasAttentionHint: true,
    selectedLaneVisible: true,
  })).toEqual({
    gap: 1,
    showScrollHint: false,
  })
})

test("compacts lane board and exposes scroll affordance for long workflows", () => {
  expect(laneBoardLayout({
    terminalHeight: 24,
    laneCount: 20,
    hasAttentionHint: true,
    selectedLaneVisible: true,
  })).toEqual({
    gap: 0,
    showScrollHint: true,
  })
})

test("does not show scroll affordance for compact boards that still fit", () => {
  expect(laneBoardLayout({
    terminalHeight: 24,
    laneCount: 8,
    hasAttentionHint: false,
    selectedLaneVisible: true,
  })).toEqual({
    gap: 0,
    showScrollHint: false,
  })
})
