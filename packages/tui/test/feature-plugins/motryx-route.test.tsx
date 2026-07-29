/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import path from "node:path"
import { MotryxRoute, type MotryxRouteActions } from "../../src/feature-plugins/motryx/route"
import type { MotryxControlConfig, MotryxControlSnapshot } from "../../src/feature-plugins/motryx/control"
import type { SessionSurfaceProps } from "../../src/routes/session"
import { copy as copySelection } from "../../src/util/selection"
import { createTuiPluginApi } from "../fixture/tui-plugin"

test("Motryx plugin route composes the standard session surface with the Flow/Inspect sidecar", async () => {
  const projectID = path.resolve("/tmp/motryx-route-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:19999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_route",
  }
  const lifecycle = new AbortController()
  const base = createTuiPluginApi()
  const api = {
    ...base,
    lifecycle: {
      signal: lifecycle.signal,
      onDispose: () => () => {},
    },
  } as unknown as TuiPluginApi
  const now = "2026-07-19T00:00:00.000Z"
  const snapshot: MotryxControlSnapshot = {
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
    workflow: { id: "wf", status: "ACTIVE", goal: "Ship the v1.18.3 migration" },
    lanes: Array.from({ length: 20 }, (_, index) => ({
      id: `lane_tui_${index + 1}`,
      name: index === 0 ? "TUI migration" : index === 19 ? "Final lane 20" : `Migration lane ${index + 1}`,
      status: "WORKING",
      updatedAt: now,
      reopenCount: 0,
      repairCycle: 0,
      dependsOnLaneIDs: index === 1 ? ["lane_tui_1"] : [],
      coordinatorRuntimeReadiness: "unmaterialized",
      checkerRuntimeReadiness: "unmaterialized",
    })),
    agents: [],
    artifacts: [],
    resourceBlocks: [],
    functionSlots: [],
    inboxItems: [],
    deliveryFences: [],
    diagnostics: [],
  }
  let currentSnapshot: MotryxControlSnapshot = snapshot
  let workflowResponse: "valid" | "schema-error" = "valid"
  const events = new ReadableStream<Uint8Array>()
  let workflowCalls = 0
  let actions: MotryxRouteActions | undefined
  let surfaceProps: SessionSurfaceProps | undefined
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") {
            workflowCalls += 1
            if (workflowResponse === "schema-error") return Response.json({ schemaVersion: 1 })
            return Response.json(currentSnapshot)
          }
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={(surface) => {
          surfaceProps = surface
          return (
            <box flexGrow={1} minHeight={0} flexDirection="column">
              <text>STANDARD OPENCODE SESSION</text>
              <text>{surface.sessionID}</text>
              <text>Migrate the TUI with the full conversation and prompt</text>
              <text>PERMISSION QUESTION</text>
              <text>COMPOSER STATUS</text>
              <text>{surface.interaction}</text>
            </box>
          )
        }}
        onActionsAvailable={(next) => (actions = next)}
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
      if (frame.includes("TUI migration") && frame.includes("STANDARD OPENCODE SESSION")) break
      await Bun.sleep(10)
    }
    expect(workflowCalls).toBe(1)
    expect(frame).toContain("MotryX")
    expect(frame).toContain("Ship the v1.18.3 migration / Orchestrator")
    expect(frame).not.toContain("conversation + sidecar")
    expect(frame).not.toContain("CONVERSATION")
    expect(frame).not.toContain("ROUTABLE")
    expect(frame).toContain("Ship the v1.18.3 migration")
    expect(frame).toContain("TUI migration")
    expect(frame).toContain("Migrate the TUI")
    expect(frame).toContain("interactive")
    expect(frame).not.toContain("DEBUG")
    expect(frame).not.toContain("2 Coordinator")
    expect(frame).not.toContain("/motryx flow")
    expect(frame).not.toContain("lane details")
    expect(surfaceProps?.showIdleFooter).toBe(false)
    expect(surfaceProps?.showNativeSidebar).toBe(false)
    expect(surfaceProps?.showExitEpilogue).toBe(false)
    expect(surfaceProps?.historyMutation).toBe("disabled")

    await clickFrameText(app, frame, "TUI migration")
    frame = await renderUntil(app, (value) => value.includes("[INSPECT]"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")
    expect(frame).toContain("ses_route")
    await clickFrameText(app, frame, "FLOW")
    frame = await renderUntil(app, (value) => value.includes("[FLOW]"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")

    actions!.moveLane(1)
    frame = await renderUntil(app, (value) => value.includes("Migration lane 2"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")
    expect(frame).toContain("ses_route")
    expect(frame).toContain("INSPECT")
    expect(frame).toContain("TUI migration")
    expect(frame).not.toContain("lane_tui_1")
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("Migration lane 2"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")

    actions!.showFlow()
    await app.renderOnce()
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
    expect(app.captureCharFrame()).toContain("STANDARD OPENCODE SESSION")

    app.resize(80, 24)
    await app.renderOnce()
    const restoredFrame = app.captureCharFrame()
    expect(restoredFrame).toContain("STANDARD OPENCODE SESSION")

    for (const [width, height] of [
      [40, 12],
      [60, 16],
      [80, 16],
      [80, 24],
      [99, 24],
      [100, 24],
      [120, 32],
      [160, 50],
    ]) {
      app.resize(width, height)
      await app.renderOnce()
      const responsiveFrame = app.captureCharFrame()
      expect(responsiveFrame).toContain("MotryX")
      expect(responsiveFrame).not.toContain("CONVERSATION")
      expect(responsiveFrame).toContain("STANDARD OPENCODE")
      expect(responsiveFrame).toContain("PERMISSION QUESTION")
      expect(responsiveFrame).toContain("COMPOSER STATUS")
      expect(responsiveFrame.includes("FLOW") || responsiveFrame.includes("WORKING")).toBe(true)
    }

    app.resize(80, 24)
    await app.renderOnce()
    const selectionFrame = app.captureCharFrame()

    const transcriptLine = selectionFrame.split("\n").findIndex((line) => line.includes("Migrate the TUI"))
    const transcriptColumn = selectionFrame.split("\n")[transcriptLine]!.indexOf("Migrate the TUI")
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

    currentSnapshot = {
      ...snapshot,
      workflow: {
        ...snapshot.workflow!,
        goal: "A long workflow goal that must not overlap the empty lane state. ".repeat(20),
      },
      lanes: [],
    }
    app.resize(120, 30)
    actions!.showFlow()
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("No lanes yet."))
    expect(frame).toContain("No lanes yet.")
    expect(frame).not.toContain("Nolanesyet.")

    currentSnapshot = { ...snapshot, workflow: undefined, lanes: [] }
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("No workflow yet."))
    expect(frame).toContain("Continue the Orchestrator conversation")
    expect(frame).not.toContain("No lanes yet.")

    workflowResponse = "schema-error"
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("SCHEMA ERROR"))
    expect(frame).toContain("STANDARD OPENCODE SESSION")
    expect(frame).toContain("COMPOSER STATUS")
    expect(frame).not.toContain(config.token)
    expect(frame).not.toContain("channel.db")
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

test("Motryx route shows a branded loading page until the first exact projection resolves", async () => {
  const projectID = path.resolve("/tmp/motryx-route-loading-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:24999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_loading",
  }
  const lifecycle = new AbortController()
  const base = createTuiPluginApi()
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
  } as unknown as TuiPluginApi
  let resolveWorkflow!: (response: Response) => void
  const workflow = new Promise<Response>((resolve) => (resolveWorkflow = resolve))
  const events = new ReadableStream<Uint8Array>()
  let surfaceMounted = false
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") return workflow
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={() => {
          surfaceMounted = true
          return <text>LOADED CONVERSATION</text>
        }}
        onActionsAvailable={() => {}}
      />
    ),
    { width: 80, height: 24 },
  )

  try {
    await app.renderOnce()
    let frame = app.captureCharFrame()
    expect(frame).toContain("MotryX")
    expect(frame).toContain("███▄        ▄███")
    expect(frame).toContain("████ █▄  ▄█ ████")
    expect(frame).toContain("Connecting conversation and workflow…")
    expect(frame).toContain("CONNECTING")
    expect(frame).not.toContain("LOADED CONVERSATION")
    expect(surfaceMounted).toBe(false)

    resolveWorkflow(Response.json(debugRouteSnapshot(projectID, config.orchestratorSessionID)))
    frame = await renderUntil(app, (value) => value.includes("LOADED CONVERSATION"))
    expect(frame).toContain("Orchestrator")
    expect(frame).not.toContain("CONNECTING")
    expect(surfaceMounted).toBe(true)
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

test("debug targets require exact OpenCode readback and reset on generation change", async () => {
  const projectID = path.resolve("/tmp/motryx-route-debug-project")
  const config: MotryxControlConfig = {
    apiURL: "http://127.0.0.1:29999",
    token: "control-token",
    projectID,
    orchestratorSessionID: "ses_orchestrator",
  }
  const lifecycle = new AbortController()
  const exactReads: string[] = []
  const base = createTuiPluginApi({
    client: {
      v2: {
        session: {
          async get(input: { sessionID: string }) {
            exactReads.push(input.sessionID)
            return {
              data: {
                data: {
                  id: input.sessionID,
                  agent: "coordinator",
                  location: { directory: projectID },
                },
              },
            }
          },
        },
      },
    } as TuiPluginApi["client"],
  })
  const api = {
    ...base,
    lifecycle: { signal: lifecycle.signal, onDispose: () => () => {} },
    ui: { ...base.ui, toast: () => {} },
  } as unknown as TuiPluginApi
  let snapshot = debugRouteSnapshot(projectID, config.orchestratorSessionID)
  let actions: MotryxRouteActions | undefined
  let debugSurfaceProps: SessionSurfaceProps | undefined
  const events = new ReadableStream<Uint8Array>()
  const app = await testRender(
    () => (
      <MotryxRoute
        api={api}
        config={config}
        debugView
        fetcher={async (input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          if (url.pathname === "/ic/workflow") return Response.json(snapshot)
          return new Response(events, { headers: { "content-type": "text/event-stream" } })
        }}
        sessionSurface={(surface) => {
          debugSurfaceProps = surface
          return (
            <box flexGrow={1} minHeight={0} flexDirection="column">
              <text>TARGET {surface.sessionID}</text>
              <text>MODE {surface.interaction}</text>
            </box>
          )
        }}
        onActionsAvailable={(next) => (actions = next)}
      />
    ),
    { width: 120, height: 30 },
  )

  try {
    let frame = await renderUntil(app, (value) => value.includes("Debug lane"))
    expect(frame).toContain("DEBUG")
    expect(frame).not.toContain("conversation + sidecar")
    expect(frame).not.toContain("ROUTABLE")
    expect(frame).not.toContain("Alt+1/2/3 shortcuts")
    expect(frame).toContain("TARGET ses_orchestrator")
    expect(frame).toContain("MODE interactive")
    expect(frame).not.toContain("Back to Orchestrator")

    actions!.showInspect()
    frame = await renderUntil(app, (value) => value.includes("Open Coordinator"))
    expect(frame).toContain("[Open Coordinator]")
    expect(frame).toContain("[Open Checker]")
    await clickFrameText(app, frame, "Open Coordinator")
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_coordinator"))
    expect(exactReads).toEqual(["ses_coordinator"])
    expect(frame).toContain("MODE read-only")
    expect(frame).toContain("Debug lane / Coordinator")
    expect(frame).toContain("Coordinator · Debug lane")
    expect(frame).toContain("← Back to Orchestrator")

    app.resize(100, 30)
    frame = await renderUntil(app, (value) => value.includes("← Back to Orchestrator"))
    expect(frame).toContain("TARGET ses_coordinator")
    expect(frame).toContain("← Back to Orchestrator")
    expect(frame).toContain("DEBUG")

    app.resize(60, 20)
    frame = await renderUntil(app, (value) => value.includes("← Back to Orchestrator"))
    expect(frame).toContain("TARGET ses_coordinator")
    expect(frame).toContain("← Back to Orchestrator")
    expect(frame).toContain("DBG")

    await clickFrameText(app, frame, "← Back to Orchestrator")
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_orchestrator"))
    expect(frame).toContain("MODE interactive")

    app.resize(120, 30)
    await app.renderOnce()

    actions!.focusCoordinator()
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_coordinator"))
    expect(exactReads).toEqual(["ses_coordinator", "ses_coordinator"])

    for (const [width, height] of [
      [40, 12],
      [60, 16],
      [80, 16],
      [80, 24],
      [99, 24],
      [100, 24],
      [120, 32],
      [160, 50],
    ]) {
      app.resize(width, height)
      frame = await renderUntil(app, (value) => value.includes("← Back to Orchestrator"))
      expect(frame).toContain("TARGET ses_coordinator")
      expect(frame).toContain("← Back to Orchestrator")
      if (width === 80) expect(frame.split("\n")[0]).toContain("DEBUG")
    }

    app.resize(120, 30)
    await app.renderOnce()
    await app.renderOnce()
    await app.waitFor(() => findScrollBoxes(app.renderer.root).some((box) => box.scrollHeight > box.viewport.height))
    const inspectScroll = findScrollBoxes(app.renderer.root).find((box) => box.scrollHeight > box.viewport.height)
    inspectScroll!.scrollTo(inspectScroll!.scrollHeight - inspectScroll!.viewport.height)
    await app.renderOnce()
    frame = app.captureCharFrame()
    expect(frame).toContain("DEBUG identity")
    expect(frame).toContain("coordinator session")
    expect(frame).toContain("ses_coordinator")

    actions!.focusChecker()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("TARGET ses_coordinator")

    debugSurfaceProps!.onSessionUnavailable?.(new Error("Session not found during worker sync"))
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_orchestrator"))
    expect(frame).toContain("MODE interactive")

    actions!.focusCoordinator()
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_coordinator"))
    expect(frame).toContain("MODE read-only")

    snapshot = debugRouteSnapshot(projectID, config.orchestratorSessionID, 8, "server-next")
    await actions!.refresh()
    frame = await renderUntil(app, (value) => value.includes("TARGET ses_orchestrator"))
    expect(frame).toContain("MODE interactive")
  } finally {
    lifecycle.abort()
    app.renderer.destroy()
  }
})

async function renderUntil(app: Awaited<ReturnType<typeof testRender>>, predicate: (frame: string) => boolean) {
  const deadline = Date.now() + 2_000
  let frame = ""
  while (Date.now() < deadline) {
    await app.renderOnce()
    frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  return frame
}

async function clickFrameText(app: Awaited<ReturnType<typeof testRender>>, frame: string, label: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(label))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf(label)
  expect(x).toBeGreaterThanOrEqual(0)
  await app.mockMouse.click(x, y)
  await app.renderOnce()
}

function debugRouteSnapshot(projectID: string, orchestratorSessionID: string, generation = 7, server = "server") {
  const now = "2026-07-19T00:00:00.000Z"
  return {
    schemaVersion: 2,
    projectID,
    orchestratorSessionID,
    projectionRevision: `${server}:revision`,
    route: {
      state: "ROUTABLE",
      serverGeneration: server,
      sidecarGeneration: server,
      bindingGeneration: generation,
      reconciledThrough: { sessionID: orchestratorSessionID, seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID,
      runtimeID: "runtime",
      bindingState: "ACTIVE",
      bindingGeneration: generation,
      ownerRunID: "run",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    workflow: { id: "workflow", status: "ACTIVE", goal: "Debug lane" },
    lanes: [
      {
        id: "lane_debug",
        name: "Debug lane",
        status: "WORKING",
        updatedAt: now,
        reopenCount: 0,
        repairCycle: 0,
        dependsOnLaneIDs: [],
        coordinatorSlotID: "slot_debug_coordinator",
        coordinatorRuntimeReadiness: "ready",
        checkerRuntimeReadiness: "unmaterialized",
        coordinatorRuntime: {
          slotID: "slot_debug_coordinator",
          instanceID: "inst_coordinator",
          sessionID: "ses_coordinator",
        },
      },
    ],
    agents: [
      {
        instanceID: "inst_coordinator",
        role: "coordinator",
        sessionID: "ses_coordinator",
        orchestratorSessionID,
        status: "ALIVE",
        laneIDs: ["lane_debug"],
      },
    ],
    artifacts: [],
    resourceBlocks: [],
    functionSlots: [],
    inboxItems: [],
    deliveryFences: [],
    diagnostics: [],
  }
}
