import { expect, test } from "bun:test"
import { motryxPaletteForTheme } from "../../src/routes/ic-agent/motryx-theme"

test("maps Motryx TUI theme names to route palettes", () => {
  expect(motryxPaletteForTheme("motryx").panel).toBe("#f8faf6")
  expect(motryxPaletteForTheme("motryx_light").green).toBe("#007d65")
  expect(motryxPaletteForTheme("motryx_dark").panel).toBe("#08100e")
  expect(motryxPaletteForTheme("dark").green).toBe("#52e0b7")
  expect(motryxPaletteForTheme("tokyonight").panel).toBe("#f8faf6")
})
