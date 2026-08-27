import { describe, expect, test } from "bun:test"
import { visibleProviderLabel } from "../../src/component/prompt/model-metadata"

describe("prompt model metadata", () => {
  test("does not repeat a provider already present in the model display name", () => {
    expect(
      visibleProviderLabel("GLM-5.2 (Baidu Qianfan Token Plan Personal)", "Baidu Qianfan Token Plan Personal"),
    ).toBeUndefined()
  })

  test("keeps a distinct provider label", () => {
    expect(visibleProviderLabel("Claude Sonnet 4", "Anthropic")).toBe("Anthropic")
  })
})
