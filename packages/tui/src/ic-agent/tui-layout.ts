export type MotryxTuiLayoutMode = "wide-side" | "compact-side" | "stacked" | "compact-stacked" | "conversation-first" | "safe-degraded"

export type MotryxTuiLayout = {
  mode: MotryxTuiLayoutMode
  narrow: boolean
  compact: boolean
  shortHeader: boolean
  cockpitCollapsed: boolean
  cockpitWidth: number
  cockpitHeight?: number
  cockpitContentHeight: number
  conversationWidth: number
  conversationHeight: number
  headerHeight: number
  statusHeight: number
}

const STATUS_HEIGHT = 1
const CONVERSATION_MIN_HEIGHT = 8

export function motryxTuiLayout(input: { width: number; height: number }): MotryxTuiLayout {
  const safeDegraded = input.width < 40 || input.height < 12
  const conversationFirst = !safeDegraded && input.height <= 16
  const narrow = input.width < 100
  const shortHeader = input.height < 22
  const headerHeight = shortHeader ? 1 : 2
  const contentHeight = Math.max(1, input.height - headerHeight - STATUS_HEIGHT)
  const cockpitCollapsed = safeDegraded || conversationFirst
  const side = !narrow && !cockpitCollapsed
  const cockpitWidth = input.width >= 120 ? 46 : input.width >= 100 ? 38 : Math.max(24, input.width - 4)
  const stackedBudget = Math.max(0, contentHeight - CONVERSATION_MIN_HEIGHT)
  const cockpitHeight = side
    ? undefined
    : cockpitCollapsed
      ? Math.min(2, stackedBudget)
      : input.height < 22
        ? Math.min(7, stackedBudget)
        : Math.min(10, Math.max(7, Math.floor(contentHeight * 0.42)), stackedBudget)
  const conversationHeight = side ? contentHeight : Math.max(1, contentHeight - (cockpitHeight ?? 0))
  const conversationWidth = side
    ? Math.max(24, input.width - cockpitWidth - 8)
    : Math.max(24, input.width - 6)
  const mode: MotryxTuiLayoutMode = safeDegraded
    ? "safe-degraded"
    : conversationFirst
      ? "conversation-first"
      : input.width >= 120
        ? "wide-side"
        : input.width >= 100
          ? "compact-side"
          : input.height >= 22
            ? "stacked"
            : "compact-stacked"

  return {
    mode,
    narrow: !side,
    compact: input.width < 120 || input.height < 22,
    shortHeader,
    cockpitCollapsed,
    cockpitWidth,
    cockpitHeight,
    cockpitContentHeight: side ? contentHeight : cockpitHeight ?? 0,
    conversationWidth,
    conversationHeight,
    headerHeight,
    statusHeight: STATUS_HEIGHT,
  }
}
