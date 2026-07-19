/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SessionMessage, SessionV2Info } from "@opencode-ai/sdk/v2"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import path from "node:path"
import { MotryxRoute } from "../../src/feature-plugins/motryx/route"
import type { MotryxControlConfig } from "../../src/feature-plugins/motryx/control"
import { copy as copySelection } from "../../src/util/selection"
import { createTuiPluginApi } from "../fixture/tui-plugin"

test("Motryx plugin route renders sidecar workflow and OpenCode transcript without creating either", async () => {
  const projectID = path.resolve("/tmp/motryx-route-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:19999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_route",
  }
  const lifecycle = new AbortController()
  const session = {
    id: config.orchestratorSessionID,
    projectID: "project-key",
    title: "Migration orchestrator",
    agent: "orchestrator",
    model: { providerID: "openai", id: "gpt-test", variant: "high" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    location: { directory: projectID },
  } satisfies SessionV2Info
  let messages = [
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "orchestrator",
      model: { providerID: "openai", id: "gpt-test" },
      content: [{ id: "text_assistant", type: "text", text: "Using the standard plugin route" }],
      time: { created: 2, completed: 3 },
    },
    { id: "msg_user", type: "user", text: "Migrate the TUI", time: { created: 1 } },
  ] satisfies SessionMessage[]
  let loadedSessionID: string | undefined
  let messageQuery: { sessionID: string; limit?: number; order?: "asc" | "desc" } | undefined
  let messageCalls = 0
  const eventHandlers = new Map<string, (event: { properties: { sessionID: string } }) => void>()
  const base = createTuiPluginApi({
    event: {
      on(type, handler) {
        eventHandlers.set(type, handler as (event: { properties: { sessionID: string } }) => void)
        return () => eventHandlers.delete(type)
      },
    },
    client: {
      v2: {
        session: {
          async get(input: { sessionID: string }) {
            loadedSessionID = input.sessionID
            return { data: { data: session } }
          },
          async messages(input: { sessionID: string; limit?: number; order?: "asc" | "desc" }) {
            messageCalls += 1
            messageQuery = input
            return { data: { data: messages, cursor: {} } }
          },
        },
      },
    } as TuiPluginApi["client"],
  })
  const api = {
    ...base,
    lifecycle: {
      signal: lifecycle.signal,
      onDispose: () => () => {},
    },
  } as unknown as TuiPluginApi
  const now = "2026-07-19T00:00:00.000Z"
  const snapshot = {
    schemaVersion: 2,
    projectID,
    orchestratorSessionID: config.orchestratorSessionID,
    projectionRevision: "server-generation:ic:route",
    route: {
      state: "ROUTABLE",
      serverGeneration: "server-generation",
      sidecarGeneration: "server-generation",
      bindingGeneration: 4,
      reconciledThrough: { sessionID: config.orchestratorSessionID, seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID: config.orchestratorSessionID,
      runtimeID: "runtime",
      bindingState: "ACTIVE",
      bindingGeneration: 4,
      ownerRunID: "run",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    workflow: { id: "wf", status: "ACTIVE", goal: "Ship the v1.18.3 migration", agentAllocationPolicy: {} },
    lanes: Array.from({ length: 20 }, (_, index) => ({
      id: `lane_tui_${index + 1}`,
      name: index === 0 ? "TUI migration" : index === 19 ? "Final lane 20" : `Migration lane ${index + 1}`,
      status: "WORKING",
      updatedAt: now,
      reopenCount: 0,
      repairCycle: 0,
      dependsOnLaneIDs: [],
    })),
    agents: [],
    artifacts: [],
    resourceBlocks: [],
    functionSlots: [],
    inboxItems: [],
    deliveryFences: [],
    diagnostics: [],
  }
  const events = new ReadableStream<Uint8Array>()
  let workflowCalls = 0
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") {
            workflowCalls += 1
            return Response.json(snapshot)
          }
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        onRefreshAvailable={() => {}}
      />
    ),
    { width: 120, height: 30 },
  )

  try {
    const deadline = Date.now() + 2_000
    let frame = ""
    while (Date.now() < deadline) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("TUI migration") && frame.includes("Using the standard plugin route")) break
      await Bun.sleep(10)
    }
    expect(loadedSessionID).toBe(config.orchestratorSessionID)
    expect(messageQuery).toEqual({ sessionID: config.orchestratorSessionID, limit: 100, order: "desc" })
    expect(workflowCalls).toBe(1)
    expect(frame).toContain("MOTRYX")
    expect(frame).toContain("ROUTABLE")
    expect(frame).toContain("Ship the v1.18.3 migration")
    expect(frame).toContain("TUI migration")
    expect(frame).toContain("Migrate the TUI")
    expect(frame).toContain("Using the standard plugin route")

    messages = [
      {
        id: "msg_updated",
        type: "assistant",
        agent: "orchestrator",
        model: { providerID: "openai", id: "gpt-test" },
        content: [{ id: "text_updated", type: "text", text: "Durable V2 transcript refreshed" }],
        time: { created: 4, completed: 5 },
      },
      ...messages,
    ]
    const callsBeforeRefresh = messageCalls
    eventHandlers.get("session.turn.settled")?.({ properties: { sessionID: config.orchestratorSessionID } })
    const refreshDeadline = Date.now() + 2_000
    while (Date.now() < refreshDeadline) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("Durable V2 transcript refreshed")) break
      await Bun.sleep(10)
    }
    expect(messageCalls).toBeGreaterThan(callsBeforeRefresh)
    expect(frame).toContain("Durable V2 transcript refreshed")

    await app.waitFor(() => findScrollBoxes(app.renderer.root).some((box) => box.scrollHeight > box.viewport.height))
    const workflowScroll = findScrollBoxes(app.renderer.root).find((box) => box.scrollHeight > box.viewport.height)
    expect(workflowScroll).toBeDefined()
    const maxScrollTop = workflowScroll!.scrollHeight - workflowScroll!.viewport.height
    expect(maxScrollTop).toBeGreaterThan(0)
    workflowScroll!.scrollTo(maxScrollTop)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Final lane 20")

    app.resize(39, 24)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Terminal too small.")

    app.resize(80, 24)
    await app.renderOnce()
    const restoredFrame = app.captureCharFrame()
    expect(restoredFrame).toContain("Using the standard plugin route")

    const transcriptLine = restoredFrame.split("\n").findIndex((line) => line.includes("Migrate the TUI"))
    const transcriptColumn = restoredFrame.split("\n")[transcriptLine]!.indexOf("Migrate the TUI")
    expect(transcriptLine).toBeGreaterThanOrEqual(0)
    expect(transcriptColumn).toBeGreaterThanOrEqual(0)
    await app.mockMouse.drag(transcriptColumn, transcriptLine, transcriptColumn + 7, transcriptLine)
    expect(app.renderer.getSelection()?.getSelectedText()).toContain("Migrate")
    let copied = ""
    expect(
      copySelection(
        app.renderer,
        {
          show() {},
          error(error) {
            throw error
          },
        },
        { write: async (text) => void (copied = text) },
      ),
    ).toBe(true)
    await Promise.resolve()
    expect(copied).toContain("Migrate")
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

function findScrollBoxes(root: Renderable): ScrollBoxRenderable[] {
  return [
    ...(root instanceof ScrollBoxRenderable ? [root] : []),
    ...root.getChildren().flatMap((child) => findScrollBoxes(child)),
  ]
}
