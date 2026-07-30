import type { TuiPromptAdmissionHandler } from "@opencode-ai/plugin/tui"
import { fetchMotryxSessions, type MotryxControlConfig, type MotryxFetcher, type MotryxSessionRoute } from "./control"

const DEFAULT_RECOVERY_TIMEOUT_MS = 60_000
const DEFAULT_RECOVERY_POLL_MS = 250

type Options = {
  signal?: AbortSignal
  fetcher?: MotryxFetcher
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWaiting?: () => void
  onRecovered?: () => void
}

export function createMotryxPromptAdmissionHandler(
  config: MotryxControlConfig,
  options: Options = {},
): TuiPromptAdmissionHandler {
  return async (input, next) => {
    const now = options.now ?? Date.now
    const deadline = now() + (options.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS)
    let waiting = false
    let transportError: unknown
    const markWaiting = () => {
      if (waiting) return
      waiting = true
      options.onWaiting?.()
    }
    const expected = await waitForExactRoute(config, input.sessionID, undefined, deadline, markWaiting, options)

    while (true) {
      assertActive(options.signal)
      try {
        await next()
        if (waiting) options.onRecovered?.()
        return
      } catch (error) {
        if (!isPromptTransportError(error)) throw error
        transportError = error
        markWaiting()
      }

      if (now() >= deadline) throw recoveryTimeout(deadline, transportError)
      await pause(options.pollMs ?? DEFAULT_RECOVERY_POLL_MS, options)
      await waitForExactRoute(config, input.sessionID, expected, deadline, markWaiting, options, transportError)
    }
  }
}

async function waitForExactRoute(
  config: MotryxControlConfig,
  sessionID: string,
  expected: MotryxSessionRoute | undefined,
  deadline: number,
  markWaiting: () => void,
  options: Options,
  cause?: unknown,
) {
  const now = options.now ?? Date.now
  while (true) {
    assertActive(options.signal)
    const state = await fetchMotryxSessions(config, { signal: options.signal, fetcher: options.fetcher })
    if (state.status === "ROUTABLE") {
      const current = state.current
      if (!current || current.sessionID !== sessionID) {
        throw new Error(`Motryx is ROUTABLE for a different session than ${sessionID}`)
      }
      if (expected && !sameRoute(current, expected)) {
        throw new Error("Motryx route proof changed while prompt admission was recovering")
      }
      return current
    }

    markWaiting()
    if (now() >= deadline) throw recoveryTimeout(deadline, cause)
    await pause(options.pollMs ?? DEFAULT_RECOVERY_POLL_MS, options)
  }
}

function sameRoute(left: MotryxSessionRoute, right: MotryxSessionRoute) {
  return (
    left.sessionID === right.sessionID &&
    left.serverGeneration === right.serverGeneration &&
    left.bindingGeneration === right.bindingGeneration &&
    left.ownerRunID === right.ownerRunID
  )
}

function isPromptTransportError(error: unknown) {
  if (error instanceof TypeError) return true
  if (!(error instanceof Error) || error.name === "AbortError") return false
  if (error.message.includes("network error (no response)")) return true
  return transportCause(error)
}

function transportCause(value: unknown): boolean {
  if (value instanceof TypeError) return true
  if (!value || typeof value !== "object") return false
  if ("status" in value && typeof value.status === "number") return false
  if (
    "code" in value &&
    typeof value.code === "string" &&
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "EPIPE",
      "ENETDOWN",
      "ENETUNREACH",
      "ETIMEDOUT",
      "ConnectionClosed",
      "ConnectionRefused",
      "ConnectionReset",
      "ConnectionTimedOut",
      "HostUnreachable",
      "NetworkUnreachable",
      "SocketClosed",
    ].includes(value.code)
  ) {
    return true
  }
  return "cause" in value && transportCause(value.cause)
}

function recoveryTimeout(deadline: number, cause?: unknown) {
  return new Error(`Motryx did not return to the exact ROUTABLE prompt route before deadline ${deadline}`, { cause })
}

function assertActive(signal?: AbortSignal) {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException("Prompt admission recovery was aborted", "AbortError")
}

async function pause(ms: number, options: Options) {
  assertActive(options.signal)
  if (options.sleep) {
    await options.sleep(ms)
    assertActive(options.signal)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      options.signal?.removeEventListener("abort", abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timer)
      reject(options.signal?.reason ?? new DOMException("Prompt admission recovery was aborted", "AbortError"))
    }
    const timer = setTimeout(done, ms)
    options.signal?.addEventListener("abort", abort, { once: true })
  })
}
