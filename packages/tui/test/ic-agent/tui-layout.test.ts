import { expect, test } from "bun:test"
import { motryxTuiLayout } from "../../src/ic-agent/tui-layout"

test("collapses FLOW before it can overlap the composer at 80x16", () => {
  const layout = motryxTuiLayout({ width: 80, height: 16 })

  expect(layout.mode).toBe("conversation-first")
  expect(layout.shortHeader).toBe(true)
  expect(layout.cockpitCollapsed).toBe(true)
  expect(layout.conversationHeight).toBe(12)
  expect(layout.cockpitHeight).toBe(2)
})

test("keeps a bounded stacked cockpit at 80x24", () => {
  const layout = motryxTuiLayout({ width: 80, height: 24 })

  expect(layout.mode).toBe("stacked")
  expect(layout.conversationWidth).toBe(74)
  expect(layout.conversationHeight).toBe(13)
  expect(layout.cockpitHeight).toBe(8)
})

test("keeps at least 54 conversation columns in compact side mode", () => {
  const layout = motryxTuiLayout({ width: 100, height: 24 })

  expect(layout.mode).toBe("compact-side")
  expect(layout.conversationWidth).toBe(54)
  expect(layout.cockpitWidth).toBe(38)
  expect(layout.cockpitHeight).toBeUndefined()
})

test("uses a conversation-dominant wide side layout", () => {
  const layout = motryxTuiLayout({ width: 120, height: 32 })

  expect(layout.mode).toBe("wide-side")
  expect(layout.conversationWidth).toBe(66)
  expect(layout.cockpitWidth).toBe(46)
})

test("layout matrix never allocates overlapping vertical regions", () => {
  for (const [width, height] of [[40, 12], [60, 16], [80, 16], [80, 24], [99, 24], [100, 24], [120, 32], [160, 50]]) {
    const layout = motryxTuiLayout({ width: width!, height: height! })
    if (layout.narrow) {
      expect(layout.headerHeight + layout.conversationHeight + (layout.cockpitHeight ?? 0) + layout.statusHeight).toBeLessThanOrEqual(height!)
    }
    expect(layout.conversationHeight).toBeGreaterThanOrEqual(height! >= 12 ? 8 : 1)
  }
})
