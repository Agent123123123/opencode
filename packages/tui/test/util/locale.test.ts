import { describe, expect, test } from "bun:test"
import { duration } from "../../src/util/locale"

describe("locale duration", () => {
  test("omits a duration that cannot be proven from finite timestamps", () => {
    expect(duration(Number.NaN)).toBe("")
    expect(duration(Number.POSITIVE_INFINITY)).toBe("")
    expect(duration(Number.NEGATIVE_INFINITY)).toBe("")
  })

  test("keeps finite durations", () => {
    expect(duration(0)).toBe("0ms")
    expect(duration(22_400)).toBe("22.4s")
  })
})
