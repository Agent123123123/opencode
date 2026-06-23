import type { IcLaneBoardTone } from "./projection"

export type MotryxTonePalette = {
  redDark: string
  gold: string
  blue: string
  green: string
  muted: string
  panelAlt: string
  ink: string
  shellText: string
}

export function laneBoardToneColor(tone: IcLaneBoardTone, palette: MotryxTonePalette) {
  if (tone === "blocked") return palette.redDark
  if (tone === "checking") return palette.gold
  if (tone === "active") return palette.blue
  if (tone === "done") return palette.green
  return palette.muted
}

export function laneStatusBackground(tone: IcLaneBoardTone, palette: MotryxTonePalette) {
  if (tone === "open") return palette.panelAlt
  return laneBoardToneColor(tone, palette)
}

export function laneStatusForeground(tone: IcLaneBoardTone, palette: MotryxTonePalette) {
  if (tone === "open" || tone === "checking") return palette.ink
  return palette.shellText
}

export function clipStatusLabel(status: string, truncate: (value: string, length: number) => string) {
  const value = status.toLowerCase().replace(/_/g, "-")
  if (value.includes("block") || value.includes("fail")) return "blocked"
  if (value.includes("work") || value.includes("active") || value.includes("progress")) return "active"
  if (value.includes("check") || value.includes("review")) return "check"
  if (value.includes("done") || value.includes("pass") || value.includes("complete")) return "done"
  if (value.includes("open")) return "open"
  return truncate(value, 7)
}

export function statusTone(status: string): IcLaneBoardTone {
  const value = status.toLowerCase()
  if (/block|fail|error/.test(value)) return "blocked"
  if (/check|review/.test(value)) return "checking"
  if (/work|active|progress/.test(value)) return "active"
  if (/done|pass|complete/.test(value)) return "done"
  return "open"
}
