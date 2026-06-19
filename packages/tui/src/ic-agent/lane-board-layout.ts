export type LaneBoardLayout = {
  gap: 0 | 1
  showScrollHint: boolean
}

const SIDE_CARD_CHROME_ROWS = 11
const SELECTED_ROW_EXTRA_ROWS = 1

export function laneBoardLayout(input: {
  terminalHeight: number
  laneCount: number
  hasAttentionHint: boolean
  selectedLaneVisible: boolean
}): LaneBoardLayout {
  const availableRows = Math.max(6, input.terminalHeight - SIDE_CARD_CHROME_ROWS)
  const fixedRows = input.hasAttentionHint ? 2 : 0
  const selectedExtraRows = input.selectedLaneVisible ? SELECTED_ROW_EXTRA_ROWS : 0
  const compactContentRows = input.laneCount + fixedRows + selectedExtraRows
  const roomyContentRows = compactContentRows + Math.max(0, input.laneCount - 1)
  const gap = roomyContentRows <= availableRows ? 1 : 0
  return {
    gap,
    showScrollHint: (gap === 1 ? roomyContentRows : compactContentRows) > availableRows,
  }
}
