import { expect, test } from "bun:test"
import { motryxTuiLayout } from "../../src/ic-agent/tui-layout"

test("uses a stacked cockpit at the default 80 column terminal size", () => {
  const layout = motryxTuiLayout({ width: 80, height: 24 })

  expect(layout.narrow).toBe(true)
  expect(layout.compact).toBe(true)
  expect(layout.conversationWidth).toBe(74)
  expect(layout.cockpitWidth).toBe(42)
  expect(layout.cockpitHeight).toBe(11)
})

test("keeps a compact side cockpit once there is enough horizontal room", () => {
  const layout = motryxTuiLayout({ width: 100, height: 30 })

  expect(layout.narrow).toBe(false)
  expect(layout.compact).toBe(true)
  expect(layout.conversationWidth).toBe(50)
  expect(layout.cockpitWidth).toBe(42)
  expect(layout.cockpitHeight).toBeUndefined()
})

test("uses the wider product cockpit on large terminals", () => {
  const layout = motryxTuiLayout({ width: 140, height: 40 })

  expect(layout.narrow).toBe(false)
  expect(layout.compact).toBe(false)
  expect(layout.conversationWidth).toBe(84)
  expect(layout.cockpitWidth).toBe(48)
  expect(layout.cockpitHeight).toBeUndefined()
})
