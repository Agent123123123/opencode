export type MotryxTuiLayout = {
  narrow: boolean
  compact: boolean
  cockpitWidth: number
  cockpitHeight?: number
  conversationWidth: number
}

export function motryxTuiLayout(input: { width: number; height: number }): MotryxTuiLayout {
  const narrow = input.width < 100
  const compact = input.width < 120
  const cockpitWidth = compact ? 42 : 48
  const cockpitHeight = narrow ? Math.max(10, Math.min(14, Math.floor(input.height * 0.46))) : undefined
  const conversationWidth = narrow
    ? Math.max(24, input.width - 6)
    : Math.max(24, input.width - cockpitWidth - 8)

  return {
    narrow,
    compact,
    cockpitWidth,
    cockpitHeight,
    conversationWidth,
  }
}
