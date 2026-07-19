/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
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
    title: "Migration orchestrator",
    agent: "orchestrator",
    model: { providerID: "openai", id: "gpt-test", variant: "high" },
  } as Session
  const messages = [
    { id: "msg_user", role: "user", agent: "orchestrator" },
    { id: "msg_assistant", role: "assistant", agent: "orchestrator" },
  ] as Message[]
  const base = createTuiPluginApi({
    state: {
      session: {
        get: () => session,
        messages: () => messages,
      },
    },
  })
  const parts = new Map<string, Part[]>([
    [
      "msg_user",
      [
        {
          id: "part_user",
          sessionID: config.orchestratorSessionID,
          messageID: "msg_user",
          type: "text",
          text: "Migrate the TUI",
        },
      ],
    ],
    [
      "msg_assistant",
      [
        {
          id: "part_assistant",
          sessionID: config.orchestratorSessionID,
          messageID: "msg_assistant",
          type: "text",
          text: "Using the standard plugin route",
        },
      ],
    ],
  ])
  const api = {
    ...base,
    state: {
      ...base.state,
      part: (messageID: string) => parts.get(messageID) ?? [],
    },
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
    expect(workflowCalls).toBe(1)
    expect(frame).toContain("MOTRYX")
    expect(frame).toContain("ROUTABLE")
    expect(frame).toContain("Ship the v1.18.3 migration")
    expect(frame).toContain("TUI migration")
    expect(frame).toContain("Migrate the TUI")
    expect(frame).toContain("Using the standard plugin route")

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
