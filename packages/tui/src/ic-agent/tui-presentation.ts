import { lanePresentation, type IcLaneBoardTone } from "./lane-state"

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
  if (tone === "unknown") return palette.redDark
  if (tone === "checking") return palette.gold
  if (tone === "pending") return palette.gold
  if (tone === "active") return palette.blue
  if (tone === "done") return palette.green
  if (tone === "waived") return palette.muted
  return palette.muted
}

export function laneStatusBackground(tone: IcLaneBoardTone, palette: MotryxTonePalette) {
  if (tone === "open" || tone === "waived") return palette.panelAlt
  return laneBoardToneColor(tone, palette)
}

export function laneStatusForeground(tone: IcLaneBoardTone, palette: MotryxTonePalette) {
  if (tone === "open" || tone === "waived" || tone === "checking" || tone === "pending") return palette.ink
  return palette.shellText
}

export function clipStatusLabel(status: string, truncate: (value: string, length: number) => string) {
  const presentation = lanePresentation(status)
  if (presentation.phase !== "unknown") return presentation.label
  const value = status.toLowerCase().replace(/_/g, "-")
  return truncate(value || "unknown", 9)
}

export function statusTone(status: string): IcLaneBoardTone {
  return lanePresentation(status).tone
}
