export const MOTRYX_STARTUP_COLORS = {
  shell: "#0b1815",
  cream: "#eaddc3",
  creamEdge: "#807970",
  gold: "#c8a760",
  goldEdge: "#6a5940",
  muted: "#8da39b",
} as const

export const MOTRYX_TERMINAL_ICON = [
  "mmm..........mmm",
  "mMMm........mMMm",
  "mMMMm......mMMMm",
  "mMMMMm....mMMMMm",
  "mMMMMMm..mMMMMMm",
  "mMMMMMMmmMMMMMMm",
  "mMMmmMMMMMMmmMMm",
  "mMMm.mMMMMm.mMMm",
  "mMMm..mMMm..mMMm",
  "mMMm...mm...mMMm",
  "mMMm.X....X.mMMm",
  "mMMm.XX..XX.mMMm",
  "mMMm.Xx..xX.mMMm",
  "mMMm.x....x.mMMm",
  "mMMm........mMMm",
  "mmmm........mmmm",
] as const

export const MOTRYX_TERMINAL_ICON_COMPACT = [
  "mm......mm",
  "MMm....mMM",
  "MMMm..mMMM",
  "MMMMmmMMMM",
  "MM.MMMM.MM",
  "MM..MM..MM",
  "MM.x..x.MM",
  "MM.XxxX.MM",
  "MM.x..x.MM",
  "mM......Mm",
] as const

export type MotryxStartupLayout = "minimal" | "compact" | "standard"

export function motryxStartupLayout(width: number, height: number): MotryxStartupLayout {
  if (width < 24 || height < 8) return "minimal"
  if (width < 48 || height < 16) return "compact"
  return "standard"
}

export function shouldShowStartupLoading(productMode: boolean, skipInitialLoading: boolean): boolean {
  return productMode || !skipInitialLoading
}

export function isMotryxStartupReady(
  pluginHostReady: boolean,
  syncStatus: "loading" | "partial" | "complete",
): boolean {
  return pluginHostReady && syncStatus !== "loading"
}
