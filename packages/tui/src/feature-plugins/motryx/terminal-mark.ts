// Generated from icon/motryx_icon_traced_dark.svg by scripts/generate-motryx-terminal-mark.mjs.
// Do not hand-edit the masks: regenerate them from the traced vector master.
export const MOTRYX_TERMINAL_MARKS = {
  compact: [
    "CC......CC",
    "CCC....CCC",
    "CCCC..CCCC",
    "CCCCCCCCCC",
    "CC.CCCC.CC",
    "CC..CC..CC",
    "CC.G..G.CC",
    "CC.G.GG.CC",
    "CC.G..G.CC",
    "CC......CC",
  ],
  standard: [
    "CCC..........CCC",
    "CCCC........CCCC",
    "CCCCC......CCCCC",
    "CCCCCC....CCCCCC",
    "CCCCCC...CCCCCCC",
    "CCCCCCC..CCCCCCC",
    "CCCCCCCCCCCCCCCC",
    "CCCC.CCCCCC.CCCC",
    "CCCC..CCCC..CCCC",
    "CCCC...CC...CCCC",
    "CCCC.G....G.CCCC",
    "CCCC.GG..GG.CCCC",
    "CCCC.GG..GG.CCCC",
    "CCCC.G....G.CCCC",
    "CCCC........CCCC",
    "CCC..........CCC",
  ],
} as const

export type MotryxTerminalMarkSize = keyof typeof MOTRYX_TERMINAL_MARKS
export type MotryxTerminalMarkColor = "." | "C" | "G"
export type MotryxTerminalMarkCell = Readonly<{
  top: MotryxTerminalMarkColor
  bottom: MotryxTerminalMarkColor
}>

export function motryxTerminalMarkRows(size: MotryxTerminalMarkSize): MotryxTerminalMarkCell[][] {
  const halfRows = MOTRYX_TERMINAL_MARKS[size]
  return Array.from({ length: halfRows.length / 2 }, (_, row) => {
    const upper = halfRows[row * 2]
    const lower = halfRows[row * 2 + 1]
    return Array.from(upper, (top, column) => ({
      top: top as MotryxTerminalMarkColor,
      bottom: lower[column] as MotryxTerminalMarkColor,
    }))
  })
}

export function motryxTerminalMarkGlyph(cell: MotryxTerminalMarkCell) {
  if (cell.top === "." && cell.bottom === ".") return " "
  if (cell.top === cell.bottom) return "█"
  if (cell.top === ".") return "▄"
  return "▀"
}
