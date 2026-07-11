import { expect, test } from "bun:test"
import {
  clipStatusLabel,
  laneBoardToneColor,
  laneStatusBackground,
  laneStatusForeground,
  statusTone,
  type MotryxTonePalette,
} from "../../src/ic-agent/tui-presentation"

const palette: MotryxTonePalette = {
  redDark: "danger",
  gold: "accent",
  blue: "active",
  green: "done",
  muted: "muted",
  panelAlt: "panel-alt",
  ink: "ink",
  shellText: "shell-text",
}

test("keeps red reserved for blocked or failed lane states", () => {
  expect(laneBoardToneColor("blocked", palette)).toBe("danger")
  expect(laneBoardToneColor("active", palette)).toBe("active")
  expect(laneBoardToneColor("checking", palette)).toBe("accent")
  expect(laneBoardToneColor("pending", palette)).toBe("accent")
  expect(laneBoardToneColor("done", palette)).toBe("done")
  expect(laneBoardToneColor("waived", palette)).toBe("muted")
  expect(laneBoardToneColor("open", palette)).toBe("muted")
  expect(laneBoardToneColor("unknown", palette)).toBe("danger")
})

test("uses readable status chip foregrounds by lane tone", () => {
  expect(laneStatusBackground("open", palette)).toBe("panel-alt")
  expect(laneStatusForeground("open", palette)).toBe("ink")
  expect(laneStatusForeground("checking", palette)).toBe("ink")
  expect(laneStatusForeground("active", palette)).toBe("shell-text")
  expect(laneStatusForeground("blocked", palette)).toBe("shell-text")
})

test("maps raw workflow statuses into product status labels", () => {
  const truncate = (value: string, length: number) => value.slice(0, length)

  expect(clipStatusLabel("BLOCKED", truncate)).toBe("blocked")
  expect(clipStatusLabel("WORKING", truncate)).toBe("active")
  expect(clipStatusLabel("AWAITING_CHECK", truncate)).toBe("awaiting check")
  expect(clipStatusLabel("CHECKING", truncate)).toBe("checking")
  expect(clipStatusLabel("PENDING", truncate)).toBe("needs decision")
  expect(clipStatusLabel("DONE", truncate)).toBe("done")
  expect(clipStatusLabel("WAIVED", truncate)).toBe("waived")
  expect(clipStatusLabel("OPEN", truncate)).toBe("open")
  expect(clipStatusLabel("waiting_for_input", truncate)).toBe("waiting-f")
})

test("maps raw workflow statuses into product color tones", () => {
  expect(statusTone("BLOCKED")).toBe("blocked")
  expect(statusTone("AWAITING_CHECK")).toBe("checking")
  expect(statusTone("CHECKING")).toBe("checking")
  expect(statusTone("WORKING")).toBe("active")
  expect(statusTone("PENDING")).toBe("pending")
  expect(statusTone("DONE")).toBe("done")
  expect(statusTone("WAIVED")).toBe("waived")
  expect(statusTone("OPEN")).toBe("open")
  expect(statusTone("queued")).toBe("unknown")
})
