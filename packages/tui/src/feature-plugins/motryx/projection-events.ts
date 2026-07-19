import {
  MOTRYX_CONTROL_SCHEMA_VERSION,
  MotryxControlHttpError,
  MotryxControlSchemaError,
  fetchMotryxControlSnapshot,
  motryxControlURL,
  type MotryxControlConfig,
  type MotryxControlSnapshot,
  type MotryxFetcher,
} from "./control"

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024
const MIN_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

export type MotryxSseFrame = {
  event: string
  data: string
  id?: string
  retry?: number
  comments: string[]
  hasData: boolean
}

export type MotryxProjectionEvent = {
  schemaVersion: typeof MOTRYX_CONTROL_SCHEMA_VERSION
  projectID: string
  orchestratorSessionID: string
  bindingGeneration: number
  projectionRevision: string
}

export type MotryxProjectionPhase =
  | "connecting"
  | "live"
  | "starting"
  | "stale"
  | "unbound"
  | "auth-error"
  | "schema-error"
  | "disposed"

export type MotryxProjectionState = {
  phase: MotryxProjectionPhase
  detail?: string
  lastEventAt?: number
  lastSnapshotAt?: number
}

type RefreshResult = "ok" | "retry" | "terminal"

export type MotryxProjectionControllerOptions = {
  config: MotryxControlConfig
  fetcher?: MotryxFetcher
  signal?: AbortSignal
  maxFrameBytes?: number
  staleAfterMs?: number
  random?: () => number
  now?: () => number
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  onSnapshot: (snapshot: MotryxControlSnapshot) => void
  onState: (state: MotryxProjectionState) => void
  onInvalidated?: (reason: string) => void
}

export function createMotryxProjectionController(options: MotryxProjectionControllerOptions) {
  const fetcher = options.fetcher ?? fetch
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const wait = options.delay ?? abortableDelay
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const staleAfterMs = Math.max(10, options.staleAfterMs ?? 45_000)
  const controller = new AbortController()
  let stopped = false
  let terminal = false
  let started = false
  let snapshot: MotryxControlSnapshot | undefined
  let state: MotryxProjectionState = { phase: "connecting" }
  let refreshTask: Promise<RefreshResult> | undefined
  let refreshDirty = false
  let loopTask: Promise<void> | undefined
  let lastEventID = ""
  let retryHint: number | undefined
  let attempt = 0
  let staleTimer: ReturnType<typeof setTimeout> | undefined

  const externalAbort = () => dispose()
  options.signal?.addEventListener("abort", externalAbort, { once: true })

  function publishState(next: MotryxProjectionState) {
    state = next
    if (!stopped) options.onState(next)
  }

  function clearProof(phase: MotryxProjectionPhase, detail: string) {
    publishState({
      phase,
      detail,
      lastEventAt: state.lastEventAt,
      lastSnapshotAt: state.lastSnapshotAt,
    })
  }

  function clearStaleTimer() {
    clearTimeout(staleTimer)
    staleTimer = undefined
  }

  function armStaleTimer() {
    clearStaleTimer()
    staleTimer = setTimeout(() => {
      if (stopped || terminal) return
      clearProof("stale", "Motryx control heartbeat is stale")
    }, staleAfterMs)
    staleTimer.unref?.()
  }

  function touchEvent() {
    const eventAt = now()
    publishState({
      phase: snapshot ? "live" : state.phase,
      lastEventAt: eventAt,
      lastSnapshotAt: state.lastSnapshotAt,
    })
    armStaleTimer()
  }

  function handleError(error: unknown): RefreshResult {
    if (stopped || isAbort(error)) return "terminal"
    if (error instanceof MotryxControlHttpError) {
      if (error.status === 401 || error.status === 403) {
        terminal = true
        clearProof("auth-error", `Control API authorization failed (HTTP ${error.status})`)
        return "terminal"
      }
      if (error.status === 404 || error.status === 409) {
        clearProof("unbound", `The requested Motryx route is not available (HTTP ${error.status})`)
        return "retry"
      }
      if (error.status === 503) {
        clearProof("starting", "Motryx is starting or reconciling")
        return "retry"
      }
      clearProof("stale", `Control API returned HTTP ${error.status}`)
      return "retry"
    }
    if (error instanceof MotryxControlSchemaError) {
      clearProof("schema-error", error.message)
      return "retry"
    }
    clearProof("stale", error instanceof Error ? error.message : String(error))
    return "retry"
  }

  async function fetchSnapshot(): Promise<RefreshResult> {
    try {
      const next = await fetchMotryxControlSnapshot(options.config, {
        fetcher,
        signal: controller.signal,
      })
      if (stopped) return "terminal"
      snapshot = next
      const at = now()
      options.onSnapshot(next)
      publishState({
        phase: "live",
        lastEventAt: state.lastEventAt,
        lastSnapshotAt: at,
      })
      return "ok"
    } catch (error) {
      return handleError(error)
    }
  }

  function refresh(): Promise<RefreshResult> {
    if (stopped || terminal) return Promise.resolve("terminal")
    if (refreshTask) {
      refreshDirty = true
      return refreshTask
    }
    refreshTask = (async () => {
      let result: RefreshResult = "retry"
      do {
        refreshDirty = false
        result = await fetchSnapshot()
      } while (!stopped && !terminal && refreshDirty)
      return result
    })().finally(() => {
      refreshTask = undefined
    })
    return refreshTask
  }

  function validateProjectionEvent(frame: MotryxSseFrame): MotryxProjectionEvent {
    let value: unknown
    try {
      value = JSON.parse(frame.data)
    } catch {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} contains invalid JSON`)
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} data must be an object`)
    }
    const item = value as Record<string, unknown>
    if (item.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION) {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} schema version does not match`)
    }
    if (
      typeof item.projectID !== "string" ||
      normalizeProject(item.projectID) !== normalizeProject(options.config.projectID)
    ) {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} project identity does not match`)
    }
    if (item.orchestratorSessionID !== options.config.orchestratorSessionID) {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} session identity does not match`)
    }
    if (!Number.isInteger(item.bindingGeneration) || (item.bindingGeneration as number) < 1) {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} binding generation is invalid`)
    }
    if (typeof item.projectionRevision !== "string" || !item.projectionRevision) {
      throw new MotryxControlSchemaError(`Control SSE ${frame.event} projection revision is invalid`)
    }
    return item as MotryxProjectionEvent
  }

  function eventMatchesProof(event: MotryxProjectionEvent) {
    if (!snapshot) return true
    return (
      event.bindingGeneration === snapshot.binding.bindingGeneration &&
      event.projectionRevision.startsWith(`${snapshot.route.serverGeneration}:`)
    )
  }

  async function connect() {
    const response = await fetcher(motryxControlURL(options.config, "events"), {
      signal: controller.signal,
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${options.config.token}`,
        ...(lastEventID ? { "last-event-id": lastEventID } : {}),
      },
    })
    if (!response.ok) {
      throw new MotryxControlHttpError(response.status, `Motryx control events returned HTTP ${response.status}`)
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!contentType.includes("text/event-stream")) {
      throw new MotryxControlSchemaError("Motryx control events did not return text/event-stream")
    }
    if (!response.body) throw new MotryxControlSchemaError("Motryx control events response has no body")
    return response.body
  }

  async function run() {
    while (!stopped && !terminal) {
      publishState({
        phase: snapshot ? "stale" : "connecting",
        detail: snapshot ? "Reconnecting to Motryx control events" : undefined,
        lastEventAt: state.lastEventAt,
        lastSnapshotAt: state.lastSnapshotAt,
      })
      const refreshed = await refresh()
      if (stopped || terminal) break
      if (refreshed !== "ok") {
        attempt += 1
        await reconnectDelay(attempt)
        continue
      }

      let invalidated = false
      let sawFrame = false
      try {
        const body = await connect()
        armStaleTimer()
        for await (const frame of readMotryxSse(body, { signal: controller.signal, maxFrameBytes })) {
          if (stopped) break
          sawFrame = true
          attempt = 0
          if (frame.id !== undefined) lastEventID = frame.id
          if (frame.retry !== undefined) retryHint = clamp(frame.retry, MIN_RECONNECT_MS, MAX_RECONNECT_MS)
          touchEvent()
          if (!frame.hasData) continue
          if (frame.event === "projection.available" || frame.event === "projection.changed") {
            const event = validateProjectionEvent(frame)
            if (!eventMatchesProof(event)) {
              invalidated = true
              options.onInvalidated?.("event_generation_mismatch")
              clearProof("unbound", "Control event belongs to a different routed generation")
              break
            }
            if (event.projectionRevision !== snapshot?.projectionRevision) void refresh()
            continue
          }
          if (frame.event === "route.invalidated") {
            const reason = invalidationReason(frame.data)
            invalidated = true
            options.onInvalidated?.(reason)
            clearProof("unbound", `Motryx route invalidated: ${reason}`)
            break
          }
        }
        if (!stopped && !invalidated) clearProof("stale", "Motryx control event stream ended")
      } catch (error) {
        if (!stopped) handleError(error)
      } finally {
        clearStaleTimer()
      }
      if (stopped || terminal) break
      if (!sawFrame) attempt += 1
      await reconnectDelay(attempt || 1)
    }
  }

  async function reconnectDelay(index: number) {
    const exponential = Math.min(MAX_RECONNECT_MS, MIN_RECONNECT_MS * 2 ** Math.max(0, index - 1))
    const base = retryHint ?? exponential
    retryHint = undefined
    const jittered = Math.round(base * (0.8 + random() * 0.4))
    await wait(clamp(jittered, MIN_RECONNECT_MS, MAX_RECONNECT_MS), controller.signal).catch((error) => {
      if (!isAbort(error)) throw error
    })
  }

  function start() {
    if (!started) {
      started = true
      loopTask = run().catch((error) => {
        if (!stopped) handleError(error)
      })
    }
    return loopTask!
  }

  function dispose() {
    if (stopped) return
    stopped = true
    terminal = true
    options.signal?.removeEventListener("abort", externalAbort)
    controller.abort()
    clearStaleTimer()
    options.onState({
      phase: "disposed",
      lastEventAt: state.lastEventAt,
      lastSnapshotAt: state.lastSnapshotAt,
    })
  }

  return {
    start,
    refresh: () => refresh().then(() => undefined),
    dispose,
    get snapshot() {
      return snapshot
    },
    get currentState() {
      return state
    },
  }
}

export async function* readMotryxSse(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; maxFrameBytes?: number } = {},
): AsyncGenerator<MotryxSseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  let buffer = ""
  let completed = false
  const aborted = () => {
    void reader.cancel().catch(() => {})
  }
  options.signal?.addEventListener("abort", aborted, { once: true })
  try {
    while (true) {
      if (options.signal?.aborted) throw abortError()
      const result = await reader.read()
      if (result.done) {
        completed = true
        break
      }
      buffer += decoder.decode(result.value, { stream: true })
      while (true) {
        const boundary = frameBoundary(buffer)
        if (!boundary) break
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        if (encoder.encode(block).byteLength > maxFrameBytes) {
          throw new MotryxControlSchemaError(`Control SSE frame exceeds ${maxFrameBytes} bytes`)
        }
        const frame = parseSseFrame(block)
        if (frame) yield frame
      }
      if (encoder.encode(buffer).byteLength > maxFrameBytes) {
        throw new MotryxControlSchemaError(`Control SSE frame exceeds ${maxFrameBytes} bytes`)
      }
    }
    buffer += decoder.decode()
    if (encoder.encode(buffer).byteLength > maxFrameBytes) {
      throw new MotryxControlSchemaError(`Control SSE frame exceeds ${maxFrameBytes} bytes`)
    }
    // Per the SSE contract an unterminated final block is not dispatched.
  } finally {
    options.signal?.removeEventListener("abort", aborted)
    if (!completed || options.signal?.aborted) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function parseSseFrame(block: string): MotryxSseFrame | undefined {
  let event = "message"
  let id: string | undefined
  let retry: number | undefined
  let hasData = false
  const data: string[] = []
  const comments: string[] = []
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith(":")) {
      comments.push(line.slice(1).replace(/^ /, ""))
      continue
    }
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") event = raw || "message"
    else if (field === "data") {
      hasData = true
      data.push(raw)
    } else if (field === "id" && !raw.includes("\0")) id = raw
    else if (field === "retry" && /^\d+$/.test(raw)) retry = Number(raw)
  }
  if (!hasData && comments.length === 0 && id === undefined && retry === undefined) return
  return { event, data: data.join("\n"), id, retry, comments, hasData }
}

function frameBoundary(value: string) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value)
  if (!match || match.index === undefined) return
  return { index: match.index, length: match[0].length }
}

function invalidationReason(data: string) {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new MotryxControlSchemaError("Control SSE route.invalidated contains invalid JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MotryxControlSchemaError("Control SSE route.invalidated data must be an object")
  }
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION || typeof item.reason !== "string" || !item.reason) {
    throw new MotryxControlSchemaError("Control SSE route.invalidated envelope is invalid")
  }
  return item.reason
}

function normalizeProject(value: string) {
  return value.replace(/[\\/]+$/, "") || value
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(done, milliseconds)
    const aborted = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    function done() {
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    signal.addEventListener("abort", aborted, { once: true })
  })
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError")
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}
