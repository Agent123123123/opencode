export function dialogSelectViewportHeight(rows: number, terminalHeight: number) {
  return Math.max(2, Math.min(rows, Math.floor(terminalHeight / 2) - 6))
}
