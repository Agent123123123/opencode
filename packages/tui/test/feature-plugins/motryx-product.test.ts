import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
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

  test("derives transcript only from OpenCode V2 conversation text and hides internal hints", () => {
    const messages = [
      { id: "msg_user", type: "user", text: "Build the migration", time: { created: 1 } },
      {
        id: "msg_wake",
        type: "user",
        text: '<ic_agent_wakeup>\n{"wake_id":"internal"}\n</ic_agent_wakeup>',
        time: { created: 2 },
      },
      { id: "msg_system", type: "system", text: "hidden system context", time: { created: 3 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "orchestrator",
        model: { providerID: "openai", id: "gpt-test" },
        content: [
          { id: "text", type: "text", text: "runtime_liveness=READY\nWorking on SSE" },
          { id: "reasoning", type: "reasoning", text: "hidden reasoning" },
        ],
        time: { created: 4, completed: 5 },
      },
    ] satisfies SessionMessage[]
    expect(projectTranscript(messages)).toEqual([
      { id: "msg_user", role: "user", label: "you", text: "Build the migration" },
      { id: "msg_assistant", role: "assistant", label: "orchestrator", text: "Working on SSE" },
    ])
  })
})
