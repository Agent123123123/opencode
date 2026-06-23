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
  expect(laneBoardToneColor("done", palette)).toBe("done")
  expect(laneBoardToneColor("open", palette)).toBe("muted")
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

  expect(clipStatusLabel("BLOCKED_BY_CHECKER", truncate)).toBe("blocked")
  expect(clipStatusLabel("WORKING", truncate)).toBe("active")
  expect(clipStatusLabel("planning_review", truncate)).toBe("check")
  expect(clipStatusLabel("PASSED", truncate)).toBe("done")
  expect(clipStatusLabel("OPEN", truncate)).toBe("open")
  expect(clipStatusLabel("waiting_for_input", truncate)).toBe("waiting")
})

test("maps raw workflow statuses into product color tones", () => {
  expect(statusTone("BLOCKED_BY_CHECKER")).toBe("blocked")
  expect(statusTone("runtime_error")).toBe("blocked")
  expect(statusTone("reviewing")).toBe("checking")
  expect(statusTone("in_progress")).toBe("active")
  expect(statusTone("complete")).toBe("done")
  expect(statusTone("queued")).toBe("open")
})
