import { expect, test } from "bun:test"
import { laneBoardLayout } from "../../src/ic-agent/lane-board-layout"

test("keeps lane board airy when its real viewport has room", () => {
  expect(laneBoardLayout({ viewportHeight: 24, laneCount: 8, attentionRows: 2 })).toEqual({
    gap: 1,
    showScrollHint: false,
    availableRows: 20,
  })
})

test("compacts lane rows and pins an overflow affordance for long workflows", () => {
  expect(laneBoardLayout({ viewportHeight: 10, laneCount: 20, attentionRows: 2 })).toEqual({
    gap: 0,
    showScrollHint: true,
    availableRows: 6,
  })
})

test("accounts for every visible attention row", () => {
  expect(laneBoardLayout({ viewportHeight: 10, laneCount: 6, attentionRows: 4 })).toEqual({
    gap: 0,
    showScrollHint: true,
    availableRows: 4,
  })
})
