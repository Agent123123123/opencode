import { expect, test } from "bun:test"
import { continueAfterProviderConnection } from "../src/component/dialog-provider"

test("provider connection keeps the standard OpenCode model transition by default", async () => {
  const shown: string[] = []

  await continueAfterProviderConnection({
    providerID: "example",
    showModels(providerID) {
      shown.push(providerID)
    },
  })

  expect(shown).toEqual(["example"])
})

test("a product completion handler reuses provider auth without opening model selection", async () => {
  const completed: string[] = []
  const shown: string[] = []

  await continueAfterProviderConnection({
    providerID: "example",
    async onConnected(providerID) {
      await Promise.resolve()
      completed.push(providerID)
    },
    showModels(providerID) {
      shown.push(providerID)
    },
  })

  expect(completed).toEqual(["example"])
  expect(shown).toEqual([])
})
