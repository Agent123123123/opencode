import { expect, test } from "bun:test"
import type { PromptInfo } from "../src/prompt/history"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { v2PromptInput, v2TurnHasTerminalAssistant } from "../src/context/session-v2"

test("maps existing TUI attachments to the V2 prompt contract", () => {
  const parts: PromptInfo["parts"] = [
    {
      type: "file",
      mime: "text/typescript",
      filename: "index.ts",
      url: "file:///tmp/project/src/index.ts",
      source: {
        type: "file",
        path: "src/index.ts",
        text: { value: "src/index.ts", start: 4, end: 16 },
      },
    },
    {
      type: "agent",
      name: "analyst",
      source: { value: "@analyst", start: 18, end: 26 },
    },
  ]

  expect(v2PromptInput("Inspect this", parts)).toEqual({
    text: "Inspect this",
    files: [
      {
        uri: "file:///tmp/project/src/index.ts",
        name: "index.ts",
        description: "src/index.ts",
        source: { text: "src/index.ts", start: 4, end: 16 },
      },
    ],
    agents: [{ name: "analyst", source: { text: "@analyst", start: 18, end: 26 } }],
  })
})

test("recognizes only a terminal assistant after the exact V2 input", () => {
  const inputID = "message-user"
  const messages: SessionMessage[] = [
    { id: inputID, type: "user", text: "Run", time: { created: 10 } },
    {
      id: "message-tool-step",
      type: "assistant",
      agent: "orchestrator",
      model: { providerID: "provider", id: "model" },
      time: { created: 20, completed: 30 },
      content: [],
      finish: "tool-calls",
    },
  ]

  expect(v2TurnHasTerminalAssistant(messages, inputID)).toBe(false)
  messages.push({
    id: "message-final",
    type: "assistant",
    agent: "orchestrator",
    model: { providerID: "provider", id: "model" },
    time: { created: 40, completed: 50 },
    content: [],
    finish: "stop",
  })
  expect(v2TurnHasTerminalAssistant(messages, inputID)).toBe(true)
  expect(v2TurnHasTerminalAssistant(messages, "another-input")).toBe(false)
})
