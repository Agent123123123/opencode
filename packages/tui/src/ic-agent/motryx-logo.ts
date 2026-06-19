export type MotryxLogoSize = "thumb" | "small" | "large"
export type MotryxLogoTone = "green" | "gold"
export type MotryxLogoVariant = "ascii" | "rich"

export type MotryxLogoSegment = {
  text: string
  tone: MotryxLogoTone
}

export const MOTRYX_LOGO_ENV = "MOTRYX_TUI_LOGO"

const ASCII_LOGOS = {
  thumb: [
    [{ text: String.raw`M\  /M`, tone: "green" }],
    [{ text: String.raw`M \/ M`, tone: "green" }],
    [{ text: "M ", tone: "green" }, { text: "><", tone: "gold" }, { text: " M", tone: "green" }],
  ],
  small: [
    [{ text: String.raw`M\    /M`, tone: "green" }],
    [{ text: String.raw`M \  / M`, tone: "green" }],
    [{ text: String.raw`M  \/  M`, tone: "green" }],
    [{ text: "M  ", tone: "green" }, { text: "><", tone: "gold" }, { text: "  M", tone: "green" }],
  ],
  large: [
    [{ text: String.raw`M\        /M`, tone: "green" }],
    [{ text: String.raw`M \      / M`, tone: "green" }],
    [{ text: String.raw`M  \    /  M`, tone: "green" }],
    [{ text: String.raw`M   \  /   M`, tone: "green" }],
    [{ text: String.raw`M    \/    M`, tone: "green" }],
    [{ text: "M    ", tone: "green" }, { text: "><", tone: "gold" }, { text: "    M", tone: "green" }],
  ],
} satisfies Record<MotryxLogoSize, readonly (readonly MotryxLogoSegment[])[]>

const RICH_LOGOS = {
  thumb: [
    [{ text: "█▚  ▞█", tone: "green" }],
    [{ text: "█ ▚▞ █", tone: "green" }],
    [{ text: "█ ", tone: "green" }, { text: "▶◀", tone: "gold" }, { text: " █", tone: "green" }],
  ],
  small: [
    [{ text: "█▚    ▞█", tone: "green" }],
    [{ text: "█ ▚  ▞ █", tone: "green" }],
    [{ text: "█  ▚▞  █", tone: "green" }],
    [{ text: "█  ", tone: "green" }, { text: "▶◀", tone: "gold" }, { text: "  █", tone: "green" }],
  ],
  large: [
    [{ text: "█▚        ▞█", tone: "green" }],
    [{ text: "█ ▚      ▞ █", tone: "green" }],
    [{ text: "█  ▚    ▞  █", tone: "green" }],
    [{ text: "█   ▚  ▞   █", tone: "green" }],
    [{ text: "█    ▚▞    █", tone: "green" }],
    [{ text: "█    ", tone: "green" }, { text: "▶◀", tone: "gold" }, { text: "    █", tone: "green" }],
  ],
} satisfies Record<MotryxLogoSize, readonly (readonly MotryxLogoSegment[])[]>

export function motryxLogoLines(size: MotryxLogoSize, variant: MotryxLogoVariant) {
  return variant === "rich" ? RICH_LOGOS[size] : ASCII_LOGOS[size]
}

export function motryxLogoPlainLines(size: MotryxLogoSize, variant: MotryxLogoVariant) {
  return motryxLogoLines(size, variant).map((line) => line.map((segment) => segment.text).join(""))
}

export function motryxLogoVariant(env: Record<string, string | undefined> = process.env): MotryxLogoVariant {
  const value = env[MOTRYX_LOGO_ENV]?.toLowerCase()
  return value === "rich" || value === "unicode" || value === "1" || value === "true" ? "rich" : "ascii"
}
