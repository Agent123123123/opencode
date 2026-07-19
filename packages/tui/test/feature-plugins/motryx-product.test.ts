import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"
import { motryxProductLayout } from "../../src/feature-plugins/motryx/layout"
import { projectTranscript } from "../../src/feature-plugins/motryx/route"

describe("Motryx product TUI", () => {
  test("ships as an opt-in builtin on the ordinary plugin route", () => {
    const plugin = createBuiltinPlugins({ experimentalEventSystem: false }).find((item) => item.id === "motryx")
    expect(plugin).toBeDefined()
    expect(plugin?.enabled).toBe(false)
    expect(plugin?.server).toBeUndefined()
    expect(typeof plugin?.tui).toBe("function")
  })

  test("has deterministic safe, short, stacked, and side layouts", () => {
    expect(motryxProductLayout({ width: 39, height: 24 })).toMatchObject({ mode: "safe", showTranscript: false })
    expect(motryxProductLayout({ width: 80, height: 16 })).toMatchObject({
      mode: "conversation-first",
      direction: "column",
      workflowHeight: 5,
    })
    expect(motryxProductLayout({ width: 80, height: 24 })).toMatchObject({ mode: "stacked", direction: "column" })
    expect(motryxProductLayout({ width: 100, height: 30 })).toMatchObject({
      mode: "side",
      direction: "row",
      workflowWidth: 38,
    })
    expect(motryxProductLayout({ width: 120, height: 40 })).toMatchObject({ workflowWidth: 46 })
  })

  test("derives transcript only from OpenCode messages/parts and hides internal hints", () => {
    const messages = [
      { id: "msg_user", role: "user", agent: "orchestrator" },
      { id: "msg_assistant", role: "assistant", agent: "orchestrator" },
    ] as Message[]
    const parts = new Map([
      ["msg_user", [{ type: "text", text: "Build the migration" }]],
      [
        "msg_assistant",
        [
          { type: "text", text: "runtime_liveness=READY\nWorking on SSE" },
          { type: "text", text: "hidden", synthetic: true },
        ],
      ],
    ])
    expect(projectTranscript(messages, (id) => parts.get(id) ?? [])).toEqual([
      { id: "msg_user", role: "user", label: "you", text: "Build the migration" },
      { id: "msg_assistant", role: "assistant", label: "orchestrator", text: "Working on SSE" },
    ])
  })
})
