/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { DataProvider, useData } from "../../../src/context/data"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function emitEvent(events: ReturnType<typeof createEventSource>, payload: Event & { durable?: { aggregateID: string; seq: number; version: number } }) {
  const { durable, ...event } = payload
  events.emit(global(event as Event))
  if (durable) events.emit({ directory, project: "proj_test", payload: { type: "sync", id: "evt_sync", syncEvent: {
    id: "id" in payload ? payload.id! : "evt_fixture", type: `${payload.type}.${durable.version}`,
    aggregateID: durable.aggregateID, seq: durable.seq, data: payload.type === "session.next.retried" && payload.properties.retryNotBefore !== undefined
      ? { ...payload.properties, retryNotBefore: new Date(payload.properties.retryNotBefore).toISOString() } : payload.properties,
  } } } as GlobalEvent)
}

test("native retries retain exact Turn identity and clear only on new response or terminal progress", async () => {
  const events = createEventSource()
  const calls = createFetch(() => undefined, events)
  let data!: ReturnType<typeof useData>
  function Probe() {
    data = useData()
    return <text>{data.session.retry("ses_retry")?.phase ?? "no retry"}</text>
  }
  const app = await testRender(() => <TestTuiContexts>
    <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
      <ProjectProvider><DataProvider><Probe /></DataProvider></ProjectProvider>
    </SDKProvider>
  </TestTuiContexts>)
  const started = { sessionID: "ses_retry", timestamp: 1, turnID: "turn_retry", turnStartedAt: 1, activityInputIDs: ["input_retry"] }
  const failure = { kind: "rate_limit" as const, safeMessage: "Rate limited", retryable: true,
    retryExhausted: false, attemptCount: 1, httpStatus: 429 }
  const retry = { sessionID: "ses_retry", timestamp: 3, turnID: "turn_retry", activityInputIDs: ["input_retry"],
    requestID: "request_retry", phase: "waiting" as const, retryAttempt: 1, retryLimit: 2, retryNotBefore: 1000, failure }
  const step = { sessionID: "ses_retry", timestamp: 2, assistantMessageID: "assistant_old", agent: "build",
    model: { id: "model", providerID: "fixture" } }
  try {
    await wait(() => Boolean(data))
    emitEvent(events, { id: "evt_start", type: "session.turn.started", durable: { aggregateID: "ses_retry", seq: 1, version: 2 }, properties: started })
    emitEvent(events, { id: "evt_step", type: "session.next.step.started", durable: { aggregateID: "ses_retry", seq: 2, version: 1 }, properties: step })
    emitEvent(events, { id: "evt_retry", type: "session.next.retried", durable: { aggregateID: "ses_retry", seq: 3, version: 2 }, properties: retry })
    await wait(() => data.session.retry("ses_retry")?.phase === "waiting")
    expect(data.session.retry("ses_retry")?.retryNotBefore).toBe(1000)
    expect(data.session.turnID("ses_retry")).toBe("turn_retry")
    emitEvent(events, { id: "evt_requesting", type: "session.next.retried", durable: { aggregateID: "ses_retry", seq: 4, version: 2 },
      properties: { ...retry, phase: "requesting", retryNotBefore: undefined } })
    await wait(() => data.session.retry("ses_retry")?.phase === "requesting")
    expect(data.session.retry("ses_retry")?.retryNotBefore).toBeUndefined()
    emitEvent(events, { id: "evt_old_step", type: "session.next.step.started", durable: { aggregateID: "ses_retry", seq: 5, version: 1 }, properties: step })
    await app.renderOnce()
    expect(data.session.retry("ses_retry")?.phase).toBe("requesting")
    emitEvent(events, { id: "evt_new_step", type: "session.next.step.started", durable: { aggregateID: "ses_retry", seq: 6, version: 1 },
      properties: { ...step, assistantMessageID: "assistant_new" } })
    await wait(() => data.session.retry("ses_retry") === undefined)
    emitEvent(events, { id: "evt_end", type: "session.turn.settled", durable: { aggregateID: "ses_retry", seq: 7, version: 3 },
      properties: { ...started, schema: "opencode.turn_settled.v3", outcome: "completed" } })
    emitEvent(events, { id: "evt_late_retry", type: "session.next.retried", durable: { aggregateID: "ses_retry", seq: 8, version: 2 }, properties: retry })
    await app.renderOnce()
    expect(data.session.retry("ses_retry")).toBeUndefined()
    await wait(() => data.session.turnID("ses_retry") === undefined)
  } finally { app.renderer.destroy() }
})

test("refreshes exact sessions into reactive getters", async () => {
  const events = createEventSource()
  const requested = new Set<string>()
  const calls = createFetch((url) => {
    requested.add(url.pathname)
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          title: "Test session",
          model: { providerID: "old-provider", id: "model", variant: "high" },
          location: { directory },
        },
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    expect(data.session.get("ses_test")).toBeUndefined()

    await data.session.refresh("ses_test")

    expect(data.session.get("ses_test")?.title).toBe("Test session")
    emitEvent(events, {
      id: "evt_title_changed_1",
      type: "session.next.title.changed",
      properties: {
        sessionID: "ses_test",
        timestamp: 42,
        title: "Renamed session",
      },
    })
    await wait(() => data.session.get("ses_test")?.title === "Renamed session")
    expect(data.session.get("ses_test")?.time.updated).toBe(42)
    emitEvent(events, {
      id: "evt_model_requested",
      type: "session.next.model.switch.requested",
      properties: {
        sessionID: "ses_test",
        timestamp: 43,
        model: { providerID: "new-provider", id: "model" },
      },
    })
    await Bun.sleep(20)
    expect(data.session.get("ses_test")?.model).toEqual({ providerID: "old-provider", id: "model", variant: "high" })
    emitEvent(events, {
      id: "evt_model_switched",
      type: "session.next.model.switched",
      properties: {
        sessionID: "ses_test",
        messageID: "msg_model_switched",
        timestamp: 44,
        model: { providerID: "new-provider", id: "model" },
      },
    })
    await wait(() => data.session.get("ses_test")?.model?.providerID === "new-provider")
    expect(data.session.get("ses_test")?.model).toEqual({ providerID: "new-provider", id: "model" })
    expect(data.session.get("ses_test")?.time.updated).toBe(44)
    expect(data.session.message.list("ses_test")).toEqual([
      {
        id: "msg_model_switched",
        type: "model-switched",
        model: { providerID: "new-provider", id: "model" },
        time: { created: 44 },
      },
    ])
    await Bun.sleep(20)
    for (const path of ["/api/agent", "/api/command", "/api/integration", "/api/model", "/api/provider", "/api/skill"])
      expect(requested.has(path)).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes references after updates", async () => {
  const events = createEventSource()
  let requests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/reference") return
    requests++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data: requests === 1 ? [] : [{ name: "docs", path: "/docs", source: { type: "local", path: "/docs" } }],
    })
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => requests === 1)
    emitEvent(events, { id: "evt_reference_1", type: "reference.updated", properties: {} })
    await wait(() => data.location.reference.list()?.length === 1)
    expect(data.location.reference.list()?.[0]?.name).toBe("docs")
  } finally {
    app.renderer.destroy()
  }
})

test("settles pending tools when a live failure arrives", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_step_started_1",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        timestamp: 1,
        agent: "build",
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitEvent(events, {
      id: "evt_input_1",
      type: "session.next.tool.input.started",
      properties: {
        sessionID: "session-1",
        turnID: "msg_turn_1",
        activityInputIDs: ["msg_input_1"],
        assistantMessageID: "msg_explicit_assistant_9",
        timestamp: 2,
        callID: "call-1",
        name: "bash",
      },
    })
    emitEvent(events, {
      id: "evt_called_1",
      type: "session.next.tool.called",
      properties: {
        sessionID: "session-1",
        turnID: "msg_turn_1",
        activityInputIDs: ["msg_input_1"],
        timestamp: 2,
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        tool: "bash",
        input: {},
        provider: { executed: false, metadata: { fake: { call: true } } },
      },
    })
    emitEvent(events, {
      id: "evt_failed_1",
      type: "session.next.tool.failed",
      properties: {
        sessionID: "session-1",
        timestamp: 3,
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        error: { type: "unknown", message: "aborted" },
        provider: { executed: false, metadata: { fake: { result: true } } },
      },
    })

    await wait(() => {
      const assistant = sync.session.message.list("session-1")?.[0]
      return (
        assistant?.type === "assistant" &&
        assistant.content[0]?.type === "tool" &&
        assistant.content[0].state.status === "error"
      )
    })

    const assistant = sync.session.message.list("session-1")?.[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.id).toBe("msg_explicit_assistant_9")
    const tool = assistant.content[0]
    expect(tool?.type).toBe("tool")
    if (tool?.type !== "tool") return
    expect(tool.state.status).toBe("error")
    if (tool.state.status !== "error") return
    expect(tool.state.error).toEqual({ type: "unknown", message: "aborted" })
    expect(tool.state.input).toEqual({})
    expect(tool.state.structured).toEqual({})
    expect(tool.state.content).toEqual([])
    expect(tool.provider).toEqual({
      executed: false,
      metadata: { fake: { call: true } },
      resultMetadata: { fake: { result: true } },
    })
    expect((sync.session.message.list("session-1") ?? []).map((message) => message.type)).toEqual(["assistant"])
  } finally {
    app.renderer.destroy()
  }
})

test("settles live reasoning when its durable end event arrives", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_step_started_reasoning",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-reasoning",
        assistantMessageID: "msg_reasoning",
        timestamp: 10,
        agent: "build",
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitEvent(events, {
      id: "evt_reasoning_started",
      type: "session.next.reasoning.started",
      properties: {
        sessionID: "session-reasoning",
        assistantMessageID: "msg_reasoning",
        reasoningID: "reasoning-1",
        timestamp: 11,
      },
    })
    emitEvent(events, {
      id: "evt_reasoning_delta",
      type: "session.next.reasoning.delta",
      properties: {
        sessionID: "session-reasoning",
        assistantMessageID: "msg_reasoning",
        reasoningID: "reasoning-1",
        timestamp: 12,
        delta: "partial",
      },
    })
    emitEvent(events, {
      id: "evt_reasoning_ended",
      type: "session.next.reasoning.ended",
      properties: {
        sessionID: "session-reasoning",
        assistantMessageID: "msg_reasoning",
        reasoningID: "reasoning-1",
        timestamp: 13,
        text: "complete",
      },
    })

    await wait(() => {
      const assistant = data.session.message.list("session-reasoning")?.[0]
      return assistant?.type === "assistant" && assistant.content[0]?.type === "reasoning" &&
        assistant.content[0].time?.completed === 13
    })
    const assistant = data.session.message.list("session-reasoning")?.[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.content[0]).toMatchObject({
      type: "reasoning",
      id: "reasoning-1",
      text: "complete",
      time: { created: 11, completed: 13 },
    })
  } finally {
    app.renderer.destroy()
  }
})

test("renders admitted prompts only after they become model-visible", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_admitted_1",
      type: "session.next.prompt.admitted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 0,
        prompt: { text: "hello" },
        delivery: "steer",
      },
    })
    expect(sync.session.message.list("session-1") ?? []).toEqual([])

    emitEvent(events, {
      id: "evt_prompted_1",
      type: "session.next.prompted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 0,
        prompt: { text: "hello" },
        delivery: "steer",
      },
    })

    await wait(() => sync.session.message.list("session-1")?.length === 1)
    const message = sync.session.message.list("session-1")?.[0]
    expect(message?.type).toBe("user")
    if (message?.type !== "user") return
    expect(message).toMatchObject({ id: "msg_user_1", text: "hello" })
  } finally {
    app.renderer.destroy()
  }
})

test("projects live context updates with their message ID", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_context_1",
      type: "session.next.context.updated",
      properties: {
        sessionID: "session-1",
        messageID: "msg_context_1",
        timestamp: 1,
        text: "Updated context",
      },
    })

    await wait(() => sync.session.message.list("session-1")?.length === 1)
    expect(sync.session.message.list("session-1")?.[0]).toMatchObject({
      id: "msg_context_1",
      type: "system",
      text: "Updated context",
    })
  } finally {
    app.renderer.destroy()
  }
})
