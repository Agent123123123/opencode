export type LaneBoardLayout = {
  gap: 0 | 1
  showScrollHint: boolean
  availableRows: number
}

const COCKPIT_HEADER_AND_TABS = 2

export function laneBoardLayout(input: {
  viewportHeight: number
  laneCount: number
  attentionRows: number
}): LaneBoardLayout {
  const availableRows = Math.max(0, input.viewportHeight - COCKPIT_HEADER_AND_TABS - input.attentionRows)
  const roomyRows = input.laneCount === 0 ? 0 : input.laneCount * 2 - 1
  const gap = roomyRows <= availableRows ? 1 : 0
  const usedRows = gap === 1 ? roomyRows : input.laneCount
  return {
    gap,
    showScrollHint: usedRows > availableRows,
    availableRows,
  }
}
