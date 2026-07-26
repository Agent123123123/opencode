export type MotryxProductLayout = {
  mode: "wide" | "compact-side" | "stacked" | "conversation-first" | "safe"
  direction: "row" | "column"
  sidecarWidth?: number
  sidecarHeight: number | "100%"
  showSidecar: boolean
  collapsedSidecar: boolean
}

export function motryxProductLayout(input: { width: number; height: number }): MotryxProductLayout {
  if (input.width < 40 || input.height < 12) {
    return {
      mode: "safe",
      direction: "column",
      sidecarHeight: 2,
      showSidecar: true,
      collapsedSidecar: true,
    }
  }
  if (input.height <= 16) {
    return {
      mode: "conversation-first",
      direction: "column",
      sidecarHeight: 2,
      showSidecar: true,
      collapsedSidecar: true,
    }
  }
  if (input.width >= 120) {
    return {
      mode: "wide",
      direction: "row",
      sidecarWidth: 46,
      sidecarHeight: "100%",
      showSidecar: true,
      collapsedSidecar: false,
    }
  }
  if (input.width >= 100) {
    return {
      mode: "compact-side",
      direction: "row",
      sidecarWidth: 42,
      sidecarHeight: "100%",
      showSidecar: true,
      collapsedSidecar: false,
    }
  }
  return {
    mode: "stacked",
    direction: "column",
    sidecarHeight: input.height <= 21 ? 6 : Math.min(11, Math.max(7, Math.floor(input.height * 0.36))),
    showSidecar: true,
    collapsedSidecar: false,
  }
}
