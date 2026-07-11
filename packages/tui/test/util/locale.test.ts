import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

describe("util.locale display width", () => {
  test("keeps Chinese text that fits in terminal columns", () => {
    const value = "中文显示"

    expect(value.length).toBe(4)
    expect(Locale.displayWidth(value)).toBe(8)
    expect(Locale.truncate(value, 8)).toBe(value)
  })

  test("truncates Chinese text by terminal columns", () => {
    const output = Locale.truncate("中文显示问题", 7)

    expect(output).toBe("中文显…")
    expect(Locale.displayWidth(output)).toBeLessThanOrEqual(7)
  })

  test("truncates from the left by terminal columns", () => {
    const output = Locale.truncateLeft("中文显示问题", 7)

    expect(output).toBe("…示问题")
    expect(Locale.displayWidth(output)).toBeLessThanOrEqual(7)
  })

  test("truncates the middle without exceeding display width", () => {
    const output = Locale.truncateMiddle("abcdefgh中文ijklmnop", 12)

    expect(output.startsWith("abcdef")).toBe(true)
    expect(output.endsWith("mnop")).toBe(true)
    expect(output).toContain("…")
    expect(Locale.displayWidth(output)).toBeLessThanOrEqual(12)
  })

  test("handles mixed English and Chinese width", () => {
    const output = Locale.truncate("Lane 中文 status", 10)

    expect(output).toBe("Lane 中文…")
    expect(Locale.displayWidth(output)).toBeLessThanOrEqual(10)
  })

  test("pads clipped CJK text to an exact terminal display width", () => {
    for (const width of [4, 6, 8]) {
      expect(Locale.displayWidth(Locale.padDisplayEnd("编排器状态", width))).toBe(width)
    }
  })
})
