export type MotryxLogoSize = "thumb" | "small" | "large"
export type MotryxWordmarkSize = "compact" | "full"
export type MotryxLogoTone = "light" | "gold"
export type MotryxLogoVariant = "ascii" | "rich"

export type MotryxLogoSegment = {
  text: string
  tone: MotryxLogoTone
}

export const MOTRYX_LOGO_ENV = "MOTRYX_TUI_LOGO"

const ASCII_LOGOS = {
  thumb: [
    [{ text: "MMM   MMM", tone: "light" }],
    [{ text: "MMMMMMMMM", tone: "light" }],
    [{ text: "MM ", tone: "light" }, { text: "X X", tone: "gold" }, { text: " MM", tone: "light" }],
  ],
  small: [
    [{ text: "MMM        MMM", tone: "light" }],
    [{ text: "MMMMM    MMMMM", tone: "light" }],
    [{ text: "MMMMMM  MMMMMM", tone: "light" }],
    [{ text: "MMMMMMMMMMMMMM", tone: "light" }],
    [{ text: "MMMM  MMMM  MM", tone: "light" }],
    [{ text: "MMMM ", tone: "light" }, { text: "XX  XX", tone: "gold" }, { text: " MM", tone: "light" }],
    [{ text: "MMMM        MM", tone: "light" }],
  ],
  large: [
    [{ text: "MMMM            MMMM", tone: "light" }],
    [{ text: "MMMMMM        MMMMMM", tone: "light" }],
    [{ text: "MMMMMMMM    MMMMMMMM", tone: "light" }],
    [{ text: "MMMMMMMMMMMMMMMMMMMM", tone: "light" }],
    [{ text: "MMMM  MMMMMMMM  MMMM", tone: "light" }],
    [{ text: "MMMM    MMMM    MMMM", tone: "light" }],
    [{ text: "MMMM  ", tone: "light" }, { text: "XX", tone: "gold" }, { text: "    ", tone: "light" }, { text: "XX", tone: "gold" }, { text: "  MMMM", tone: "light" }],
    [{ text: "MMMM  ", tone: "light" }, { text: "XXX", tone: "gold" }, { text: "  ", tone: "light" }, { text: "XXX", tone: "gold" }, { text: "  MMMM", tone: "light" }],
    [{ text: "MMMM  ", tone: "light" }, { text: "X", tone: "gold" }, { text: "      ", tone: "light" }, { text: "X", tone: "gold" }, { text: "  MMMM", tone: "light" }],
    [{ text: "MMMM            MMMM", tone: "light" }],
  ],
} satisfies Record<MotryxLogoSize, readonly (readonly MotryxLogoSegment[])[]>

const RICH_LOGOS = {
  thumb: [
    [{ text: "███   ███", tone: "light" }],
    [{ text: "█████████", tone: "light" }],
    [{ text: "██ ", tone: "light" }, { text: "◢ ◣", tone: "gold" }, { text: " ██", tone: "light" }],
  ],
  small: [
    [{ text: "███        ███", tone: "light" }],
    [{ text: "█████    █████", tone: "light" }],
    [{ text: "██████  ██████", tone: "light" }],
    [{ text: "██████████████", tone: "light" }],
    [{ text: "████  ████  ██", tone: "light" }],
    [{ text: "████ ", tone: "light" }, { text: "██  ██", tone: "gold" }, { text: " ██", tone: "light" }],
    [{ text: "████        ██", tone: "light" }],
  ],
  large: [
    [{ text: "████            ████", tone: "light" }],
    [{ text: "██████        ██████", tone: "light" }],
    [{ text: "████████    ████████", tone: "light" }],
    [{ text: "████████████████████", tone: "light" }],
    [{ text: "████  ████████  ████", tone: "light" }],
    [{ text: "████    ████    ████", tone: "light" }],
    [{ text: "████  ", tone: "light" }, { text: "██", tone: "gold" }, { text: "    ", tone: "light" }, { text: "██", tone: "gold" }, { text: "  ████", tone: "light" }],
    [{ text: "████  ", tone: "light" }, { text: "███", tone: "gold" }, { text: "  ", tone: "light" }, { text: "███", tone: "gold" }, { text: "  ████", tone: "light" }],
    [{ text: "████  ", tone: "light" }, { text: "█", tone: "gold" }, { text: "      ", tone: "light" }, { text: "█", tone: "gold" }, { text: "  ████", tone: "light" }],
    [{ text: "████            ████", tone: "light" }],
  ],
} satisfies Record<MotryxLogoSize, readonly (readonly MotryxLogoSegment[])[]>

const WORDMARKS = {
  compact: [[{ text: "Motry", tone: "light" }, { text: "X", tone: "gold" }]],
  full: [[{ text: "Motry", tone: "light" }, { text: "X", tone: "gold" }]],
} satisfies Record<MotryxWordmarkSize, readonly (readonly MotryxLogoSegment[])[]>

export function motryxLogoLines(size: MotryxLogoSize, variant: MotryxLogoVariant) {
  return variant === "rich" ? RICH_LOGOS[size] : ASCII_LOGOS[size]
}

export function motryxLogoPlainLines(size: MotryxLogoSize, variant: MotryxLogoVariant) {
  return motryxLogoLines(size, variant).map((line) => line.map((segment) => segment.text).join(""))
}

export function motryxWordmarkLines(size: MotryxWordmarkSize = "full") {
  return WORDMARKS[size]
}

export function motryxWordmarkPlainLines(size: MotryxWordmarkSize = "full") {
  return motryxWordmarkLines(size).map((line) => line.map((segment) => segment.text).join(""))
}

export function motryxLogoVariant(env: Record<string, string | undefined> = process.env): MotryxLogoVariant {
  const value = env[MOTRYX_LOGO_ENV]?.toLowerCase()
  return value === "rich" || value === "unicode" || value === "1" || value === "true" ? "rich" : "ascii"
}
