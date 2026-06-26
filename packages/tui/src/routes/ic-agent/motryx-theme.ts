import { createSignal } from "solid-js"
import { MOTRYX_DEFAULT_THEME, normalizeMotryxThemeName, type MotryxThemeName } from "../../theme"

const motryxLight = {
  shell: "#10241f",
  shellText: "#f8faf6",
  panel: "#f8faf6",
  panelAlt: "#ffffff",
  panelSoft: "#e8efea",
  ink: "#10241f",
  muted: "#53645e",
  line: "#d8e3dd",
  red: "#b94b5a",
  redDark: "#8f3745",
  gold: "#a98234",
  goldDark: "#7a5f24",
  green: "#007d65",
  blue: "#4a5d58",
  logoLight: "#a98234",
  logoGreen: "#a98234",
  codeBg: "#10241f",
  codeFg: "#f8faf6",
} as const

const motryxDark = {
  shell: "#08100e",
  shellText: "#f2f6fa",
  panel: "#08100e",
  panelAlt: "#0e1a16",
  panelSoft: "#173028",
  ink: "#f2f6fa",
  muted: "#aab7c8",
  line: "#23443a",
  red: "#f06a7a",
  redDark: "#b94b5a",
  gold: "#c8a760",
  goldDark: "#8f7338",
  green: "#52e0b7",
  blue: "#b9c7d8",
  logoLight: "#c8a760",
  logoGreen: "#c8a760",
  codeBg: "#0b1714",
  codeFg: "#f2f6fa",
} as const

export type MotryxPalette = typeof motryxLight

export const motryxPalettes = {
  motryx_light: motryxLight,
  motryx_dark: motryxDark,
} as const

const [activeMotryxTheme, setActiveMotryxTheme] = createSignal<MotryxThemeName>(MOTRYX_DEFAULT_THEME)

export function setMotryxPaletteTheme(theme: string | undefined) {
  setActiveMotryxTheme(normalizeMotryxThemeName(theme) ?? MOTRYX_DEFAULT_THEME)
}

export function motryxPaletteForTheme(theme: string | undefined) {
  return motryxPalettes[normalizeMotryxThemeName(theme) ?? MOTRYX_DEFAULT_THEME]
}

function currentMotryxPalette() {
  return motryxPalettes[activeMotryxTheme()]
}

export const motryx = new Proxy({} as MotryxPalette, {
  get(_target, property: keyof MotryxPalette) {
    return currentMotryxPalette()[property]
  },
})
