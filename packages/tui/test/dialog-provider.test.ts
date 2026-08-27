import { expect, test } from "bun:test"
import {
  continueAfterProviderConnection,
  providerOptions,
  saveProviderKeyConnection,
} from "../src/component/dialog-provider"

test("puts a required provider first without removing the normal choices", () => {
  const options = providerOptions(
    [
      { id: "openai", name: "OpenAI" },
      { id: "qianfan", name: "Qianfan" },
    ],
    "qianfan",
  )
  expect(options.map((option) => option.value)).toEqual(["qianfan", "openai", "__opencode_custom_provider__"])
  expect(options[0]?.category).toBe("Required")
})

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

test("V2 provider connection writes Integration credentials without disposing the Session runtime", async () => {
  const calls: string[] = []
  await saveProviderKeyConnection({
    sessionApi: "v2",
    connectV2: async () => calls.push("v2"),
    connectLegacy: async () => calls.push("legacy"),
    disposeLegacy: async () => calls.push("dispose"),
  })
  expect(calls).toEqual(["v2"])
})

test("ordinary TUI provider connection keeps the legacy auth lifecycle", async () => {
  const calls: string[] = []
  await saveProviderKeyConnection({
    connectV2: async () => calls.push("v2"),
    connectLegacy: async () => calls.push("legacy"),
    disposeLegacy: async () => calls.push("dispose"),
  })
  expect(calls).toEqual(["legacy", "dispose"])
})
