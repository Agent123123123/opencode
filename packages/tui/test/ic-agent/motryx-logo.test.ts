import { expect, test } from "bun:test"
import {
  motryxLogoVariant,
  motryxWordmarkLines,
  motryxWordmarkPlainLines,
} from "../../src/ic-agent/motryx-logo"

test("uses an ASCII-safe Motryx logo by default", () => {
  expect(motryxLogoVariant({})).toBe("ascii")
})

test("enables the rich Motryx logo only when explicitly requested", () => {
  expect(motryxLogoVariant({ MOTRYX_TUI_LOGO: "rich" })).toBe("rich")
  expect(motryxLogoVariant({ MOTRYX_TUI_LOGO: "unicode" })).toBe("rich")
  expect(motryxLogoVariant({ MOTRYX_TUI_LOGO: "ascii" })).toBe("ascii")
})

test("uses a clean MotryX wordmark with the traced gold X accent", () => {
  expect(motryxWordmarkPlainLines()).toEqual(["MOTRYX"])
  expect(motryxWordmarkPlainLines("compact")).toEqual(["MOTRYX"])

  const [motry, x] = motryxWordmarkLines()[0]!
  expect(motry).toEqual({ text: "MOTRY", tone: "light" })
  expect(x).toEqual({ text: "X", tone: "gold" })
})
