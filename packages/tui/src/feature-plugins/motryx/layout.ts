export type MotryxProductLayout = {
  mode: "side" | "stacked" | "conversation-first" | "safe"
  direction: "row" | "column"
  workflowWidth?: number
  workflowHeight?: number
  showTranscript: boolean
}

export function motryxProductLayout(input: { width: number; height: number }): MotryxProductLayout {
  if (input.width < 40 || input.height < 12) {
    return {
      mode: "safe",
      direction: "column",
      workflowHeight: Math.max(3, input.height - 4),
      showTranscript: false,
    }
  }
  if (input.height < 18) {
    return {
      mode: "conversation-first",
      direction: "column",
      workflowHeight: 5,
      showTranscript: true,
    }
  }
  if (input.width >= 100) {
    return {
      mode: "side",
      direction: "row",
      workflowWidth: input.width >= 120 ? 46 : 38,
      showTranscript: true,
    }
  }
  return {
    mode: "stacked",
    direction: "column",
    workflowHeight: Math.min(11, Math.max(7, Math.floor(input.height * 0.4))),
    showTranscript: true,
  }
}
