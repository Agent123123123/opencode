import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { MotryxControlConfig } from "../../src/feature-plugins/motryx/control"
import {
  createMotryxProjectionController,
  readMotryxSse,
  type MotryxProjectionState,
} from "../../src/feature-plugins/motryx/projection-events"

const encoder = new TextEncoder()
const projectID = path.resolve("/tmp/motryx-sse-project")
const config: MotryxControlConfig = {
  apiURL: "http://127.0.0.1:19001",
  token: "sse-token",
  projectID,
  orchestratorSessionID: "ses_sse",
}

function validSnapshot(revision = "server-generation:ic:one") {
  const now = "2026-07-19T00:00:00.000Z"
  return {
    schemaVersion: 5,
    projectID,
    orchestratorSessionID: config.orchestratorSessionID,
    projectionRevision: revision,
    route: {
      state: "ROUTABLE",
      serverGeneration: "server-generation",
      sidecarGeneration: "server-generation",
      bindingGeneration: 3,
      reconciledThrough: { sessionID: config.orchestratorSessionID, seq: null, eventID: null },
      observedAt: now,
    },
    binding: {
      projectID,
      orchestratorSessionID: config.orchestratorSessionID,
      runtimeID: "runtime",
      bindingState: "ACTIVE",
      bindingGeneration: 3,
      ownerRunID: "run",
      createdAt: now,
      updatedAt: now,
      activatedAt: now,
      lastRoutedAt: null,
    },
    workflow: { id: "wf", status: "ACTIVE", goal: "goal" },
    lanes: [],
    agents: [],
    artifacts: [],
    resourceBlocks: [],
    incidents: [],
    attentionItems: [],
    attention: { visibleOpenIncidentCount: 0, failedLaneCount: 0, activeAttentionCount: 0, userActionRequiredCount: 0, retryingCount: 0 },
    functionSlots: [],
    runs: [],
    attempts: [],
    diagnostics: [],
  }
}

function streamFrom(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
}

function eventData(revision: string, generation = 3) {
  return JSON.stringify({
    schemaVersion: 5,
    projectID,
    orchestratorSessionID: config.orchestratorSessionID,
    bindingGeneration: generation,
    projectionRevision: revision,
  })
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      cancelled = true
    },
  })
  return { body, controller: () => controller, cancelled: () => cancelled }
}

function holdUntilAbort(_milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
}

async function eventually(assertion: () => void, timeout = 2_000) {
  const deadline = Date.now() + timeout
  let error: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (next) {
      error = next
      await Bun.sleep(10)
    }
  }
  throw error
}

describe("Motryx control SSE decoder", () => {
  test("handles CRLF, comments, multiline data, retry, split UTF-8, and chunk boundaries", async () => {
    const raw = encoder.encode(
      ': heartbeat\r\n\r\nevent: projection.changed\r\nid: revision-2\r\nretry: 2500\r\ndata: {"message":\r\ndata: "你好"}\r\n\r\n',
    )
    const split = raw.findIndex((value, index) => index > 40 && value >= 0x80)
    const chunks = [raw.slice(0, split + 1), raw.slice(split + 1, split + 2), raw.slice(split + 2)]
    const frames = []
    for await (const frame of readMotryxSse(streamFrom(chunks))) frames.push(frame)
    expect(frames).toEqual([
      { event: "message", data: "", comments: ["heartbeat"], hasData: false },
      {
        event: "projection.changed",
        id: "revision-2",
        retry: 2500,
        data: '{"message":\n"你好"}',
        comments: [],
        hasData: true,
      },
    ])
    expect(JSON.parse(frames[1]!.data)).toEqual({ message: "你好" })
  })

  test("rejects an oversized unterminated or completed frame", async () => {
    const consume = async (body: ReadableStream<Uint8Array>) => {
      for await (const _ of readMotryxSse(body, { maxFrameBytes: 16 })) {
        // consume
      }
    }
    await expect(consume(streamFrom([encoder.encode(`data: ${"x".repeat(40)}`)]))).rejects.toThrow("exceeds 16 bytes")
    await expect(consume(streamFrom([encoder.encode(`data: ${"x".repeat(40)}\n\n`)]))).rejects.toThrow(
      "exceeds 16 bytes",
    )
  })
})

describe("Motryx projection controller", () => {
  test("does one reconnect snapshot, ignores heartbeat, and coalesces changed invalidations", async () => {
    const events = controlledStream()
    let revision = "server-generation:ic:one"
    let workflowCalls = 0
    let eventCalls = 0
    const snapshots: string[] = []
    const states: MotryxProjectionState[] = []
    const controller = createMotryxProjectionController({
      config,
      delay: holdUntilAbort,
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/ic/workflow") {
          workflowCalls += 1
          return Response.json(validSnapshot(revision))
        }
        eventCalls += 1
        return new Response(events.body, { headers: { "content-type": "text/event-stream; charset=utf-8" } })
      },
      onSnapshot: (value) => snapshots.push(value.projectionRevision),
      onState: (value) => states.push(value),
    })
    void controller.start()
    await eventually(() => {
      expect(workflowCalls).toBe(1)
      expect(eventCalls).toBe(1)
      expect(snapshots).toEqual(["server-generation:ic:one"])
    })

    events.controller().enqueue(encoder.encode(": heartbeat\n\n"))
    await eventually(() => expect(states.some((state) => state.lastEventAt !== undefined)).toBe(true))
    expect(workflowCalls).toBe(1)

    revision = "server-generation:ic:two"
    events
      .controller()
      .enqueue(
        encoder.encode(
          Array.from(
            { length: 10 },
            () => `event: projection.changed\nid: ${revision}\ndata: ${eventData(revision)}\n\n`,
          ).join(""),
        ),
      )
    await eventually(() => expect(snapshots.at(-1)).toBe(revision))
    expect(workflowCalls).toBeGreaterThanOrEqual(2)
    expect(workflowCalls).toBeLessThanOrEqual(3)
    controller.dispose()
    const stateCount = states.length
    await Bun.sleep(20)
    expect(states).toHaveLength(stateCount)
  })

  test("refetches after EOF before opening a replacement stream", async () => {
    const replacement = controlledStream()
    let workflowCalls = 0
    let eventCalls = 0
    let delayCalls = 0
    const controller = createMotryxProjectionController({
      config,
      delay: async (_milliseconds, signal) => {
        delayCalls += 1
        if (delayCalls === 1) return
        return holdUntilAbort(0, signal)
      },
      random: () => 0.5,
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/ic/workflow") {
          workflowCalls += 1
          return Response.json(validSnapshot())
        }
        eventCalls += 1
        if (eventCalls === 1) return new Response(streamFrom([]), { headers: { "content-type": "text/event-stream" } })
        return new Response(replacement.body, { headers: { "content-type": "text/event-stream" } })
      },
      onSnapshot() {},
      onState() {},
    })
    void controller.start()
    await eventually(() => {
      expect(eventCalls).toBe(2)
      expect(workflowCalls).toBe(2)
    })
    controller.dispose()
  })

  test("marks a silent connection stale, restores freshness on heartbeat, and cancels an invalidated stream", async () => {
    const events = controlledStream()
    const states: MotryxProjectionState[] = []
    const invalidated: string[] = []
    let workflowCalls = 0
    const controller = createMotryxProjectionController({
      config,
      staleAfterMs: 20,
      delay: holdUntilAbort,
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/ic/workflow") {
          workflowCalls += 1
          return Response.json(validSnapshot())
        }
        return new Response(events.body, { headers: { "content-type": "text/event-stream" } })
      },
      onSnapshot() {},
      onState: (state) => states.push(state),
      onInvalidated: (reason) => invalidated.push(reason),
    })
    void controller.start()
    await eventually(() => expect(states.at(-1)?.detail).toContain("heartbeat is stale"))
    events.controller().enqueue(encoder.encode(": heartbeat\n\n"))
    await eventually(() => {
      expect(states.at(-1)?.phase).toBe("live")
      expect(states.at(-1)?.lastEventAt).toBeNumber()
    })
    expect(workflowCalls).toBe(1)

    events
      .controller()
      .enqueue(
        encoder.encode(
          `event: route.invalidated\ndata: ${JSON.stringify({ schemaVersion: 5, reason: "binding_generation_changed" })}\n\n`,
        ),
      )
    await eventually(() => {
      expect(invalidated).toEqual(["binding_generation_changed"])
      expect(states.at(-1)?.phase).toBe("unbound")
      expect(events.cancelled()).toBe(true)
    })
    controller.dispose()
  })

  test("does not let a heartbeat resurrect a snapshot after a failed exact refresh", async () => {
    const events = controlledStream()
    const states: MotryxProjectionState[] = []
    const snapshots: string[] = []
    let revision = "server-generation:ic:one"
    let failRefresh = false
    const controller = createMotryxProjectionController({
      config,
      delay: holdUntilAbort,
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/ic/workflow") {
          if (failRefresh) return Response.json({ schemaVersion: 1 })
          return Response.json(validSnapshot(revision))
        }
        return new Response(events.body, { headers: { "content-type": "text/event-stream" } })
      },
      onSnapshot: (value) => snapshots.push(value.projectionRevision),
      onState: (state) => states.push(state),
    })
    void controller.start()
    await eventually(() => expect(states.at(-1)?.phase).toBe("live"))

    failRefresh = true
    await controller.refresh()
    expect(states.at(-1)?.phase).toBe("schema-error")
    events.controller().enqueue(encoder.encode(": heartbeat\n\n"))
    await eventually(() => expect(states.at(-1)?.lastEventAt).toBeNumber())
    expect(states.at(-1)?.phase).toBe("schema-error")

    failRefresh = false
    revision = "server-generation:ic:two"
    events.controller().enqueue(
      encoder.encode(`event: projection.changed\ndata: ${eventData(revision)}\n\n`),
    )
    await eventually(() => {
      expect(states.at(-1)?.phase).toBe("live")
      expect(snapshots.at(-1)).toBe(revision)
    })
    controller.dispose()
  })

  test("treats auth as terminal and rejects an old generation event", async () => {
    let authCalls = 0
    const authStates: MotryxProjectionState[] = []
    const auth = createMotryxProjectionController({
      config,
      delay: async () => {
        throw new Error("auth must not retry")
      },
      fetcher: async () => {
        authCalls += 1
        return new Response("unauthorized", { status: 401 })
      },
      onSnapshot() {},
      onState: (state) => authStates.push(state),
    })
    void auth.start()
    await eventually(() => expect(authStates.at(-1)?.phase).toBe("auth-error"))
    expect(authCalls).toBe(1)
    auth.dispose()

    const events = controlledStream()
    const invalidated: string[] = []
    const states: MotryxProjectionState[] = []
    const oldGeneration = createMotryxProjectionController({
      config,
      delay: holdUntilAbort,
      fetcher: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.pathname === "/ic/workflow") return Response.json(validSnapshot())
        return new Response(events.body, { headers: { "content-type": "text/event-stream" } })
      },
      onSnapshot() {},
      onState: (state) => states.push(state),
      onInvalidated: (reason) => invalidated.push(reason),
    })
    void oldGeneration.start()
    await eventually(() => expect(states.some((state) => state.phase === "live")).toBe(true))
    events
      .controller()
      .enqueue(encoder.encode(`event: projection.changed\ndata: ${eventData("replacement-generation:ic:two")}\n\n`))
    await eventually(() => expect(invalidated).toEqual(["event_generation_mismatch"]))
    expect(states.at(-1)?.phase).toBe("unbound")
    oldGeneration.dispose()
  })
})
