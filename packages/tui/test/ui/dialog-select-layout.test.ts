import { describe, expect, test } from "bun:test"
import { dialogSelectViewportHeight } from "../../src/ui/dialog-select-layout"

describe("dialog select viewport", () => {
  test("keeps a category and one selectable row in the smallest supported terminal", () => {
    expect(dialogSelectViewportHeight(20, 12)).toBe(2)
  })

  test("uses the bounded half-screen viewport when space is available", () => {
    expect(dialogSelectViewportHeight(20, 16)).toBe(2)
    expect(dialogSelectViewportHeight(20, 32)).toBe(10)
  })
})
