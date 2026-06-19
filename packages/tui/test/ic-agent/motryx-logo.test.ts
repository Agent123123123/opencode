import { expect, test } from "bun:test"
import { motryxLogoPlainLines, motryxLogoVariant, type MotryxLogoSize, type MotryxLogoVariant } from "../../src/ic-agent/motryx-logo"

const sizes: MotryxLogoSize[] = ["thumb", "small", "large"]
const variants: MotryxLogoVariant[] = ["ascii", "rich"]

test("uses an ASCII-safe Motryx logo by default", () => {
  expect(motryxLogoVariant({})).toBe("ascii")
  expect(motryxLogoPlainLines("thumb", "ascii")).toEqual([
    String.raw`M\  /M`,
    String.raw`M \/ M`,
    "M >< M",
  ])
})

test("enables the rich Motryx logo only when explicitly requested", () => {
  expect(motryxLogoVariant({ MOTRYX_TUI_LOGO: "rich" })).toBe("rich")
  expect(motryxLogoVariant({ MOTRYX_TUI_LOGO: "unicode" })).toBe("rich")
  expect(motryxLogoVariant({ MOTRYX_TUI_LOGO: "ascii" })).toBe("ascii")
})

test("keeps Motryx logo rows fixed width within every size and variant", () => {
  for (const variant of variants) {
    for (const size of sizes) {
      const lines = motryxLogoPlainLines(size, variant)
      const width = lines[0]?.length
      expect(width).toBeGreaterThan(0)
      expect(lines.every((line) => line.length === width)).toBe(true)
    }
  }
})
