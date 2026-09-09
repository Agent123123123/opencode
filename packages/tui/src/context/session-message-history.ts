import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { createStore } from "solid-js/store"

const PAGE_SIZE = 100

type Page = { data: SessionMessage[]; cursor: { next?: string } }
type Touch = { metadata: boolean; parts: Set<string> }
export type MessageTouches = Map<string, Touch>

type HistoryState = {
  initialized: boolean
  loading?: "latest" | "older"
  error?: string
  failed?: "latest" | "older"
  cursor?: string
  head?: string
  more: boolean
}

const empty: HistoryState = { initialized: false, more: false }

/** Paging metadata belongs to the same provider as the messages. No second transcript is kept here. */
export function createSessionMessageHistory(input: {
  read: (
    sessionID: string,
    query: { limit: number; order?: "desc"; cursor?: string },
    signal: AbortSignal,
  ) => Promise<Page>
  list: (sessionID: string) => SessionMessage[]
  commit: (sessionID: string, messages: SessionMessage[], changed: string[]) => void
}) {
  const [state, setState] = createStore<Record<string, HistoryState>>({})
  const flights = new Map<string, { promise: Promise<void>; again: boolean }>()
  const touches = new Map<string, MessageTouches>()
  const continuations = new Map<
    string,
    { page: Page; tail: Page; messages: SessionMessage[]; previous: HistoryState; tracker: MessageTouches }
  >()
  const controller = new AbortController()

  async function read(sessionID: string, mode: "latest" | "older") {
    const continuation = mode === "latest" ? continuations.get(sessionID) : undefined
    const previous = continuation?.previous ?? { ...(state[sessionID] ?? empty) }
    setState(sessionID, { ...previous, loading: mode, error: undefined, failed: undefined })
    const tracker: MessageTouches = continuation?.tracker ?? new Map()
    touches.set(sessionID, tracker)
    try {
      const page =
        continuation?.page ??
        (await input.read(
          sessionID,
          {
            limit: PAGE_SIZE,
            ...(mode === "older" ? { cursor: previous.cursor } : { order: "desc" as const }),
          },
          controller.signal,
        ))
      const messages = continuation?.messages ?? [...page.data]
      let tail = continuation?.tail ?? page
      // Anchor to the last HTTP-confirmed head, not a newer SSE item: otherwise
      // a reconnect could overlap a live item while leaving an older hole unseen.
      while (
        mode === "latest" &&
        previous.head &&
        !messages.some((item) => item.id === previous.head) &&
        tail.data.length === PAGE_SIZE &&
        tail.cursor.next
      ) {
        continuations.set(sessionID, { page, tail, messages, previous, tracker })
        tail = await input.read(sessionID, { limit: PAGE_SIZE, cursor: tail.cursor.next }, controller.signal)
        messages.push(...tail.data)
      }
      if (controller.signal.aborted) return
      input.commit(
        sessionID,
        mergeMessagePage(input.list(sessionID), messages, mode, tracker),
        messages.map((item) => item.id),
      )
      continuations.delete(sessionID)
      const extendsHistory =
        mode === "older" ||
        !previous.initialized ||
        !previous.head ||
        (mode === "latest" && previous.head !== undefined && !messages.some((item) => item.id === previous.head))
      setState(sessionID, {
        initialized: true,
        loading: undefined,
        error: undefined,
        failed: undefined,
        head: mode === "latest" ? (page.data[0]?.id ?? previous.head) : previous.head,
        cursor: extendsHistory ? tail.cursor.next : previous.cursor,
        more: extendsHistory ? tail.data.length === PAGE_SIZE && !!tail.cursor.next : previous.more,
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        setState(sessionID, "error", error instanceof Error ? error.message : String(error))
        setState(sessionID, "failed", mode)
      }
      throw error
    } finally {
      if (!continuations.has(sessionID)) touches.delete(sessionID)
      if (!controller.signal.aborted) setState(sessionID, "loading", undefined)
    }
  }

  function run(sessionID: string, mode: "latest" | "older") {
    const flight = { promise: Promise.resolve(), again: continuations.has(sessionID) }
    flights.set(sessionID, flight)
    flight.promise = (async () => {
      await read(sessionID, mode).catch((error) => {
        if (!flight.again || controller.signal.aborted) throw error
      })
      while (flight.again && !controller.signal.aborted) {
        flight.again = false
        await read(sessionID, "latest").catch((error) => {
          if (!flight.again || controller.signal.aborted) throw error
        })
      }
    })().finally(() => flights.delete(sessionID))
    return flight.promise
  }

  return {
    state: (sessionID: string) => state[sessionID] ?? empty,
    touch(sessionID: string, messageID: string, partID?: string) {
      const tracker = touches.get(sessionID)
      if (!tracker) return
      const entry = tracker.get(messageID) ?? { metadata: false, parts: new Set<string>() }
      if (partID) entry.parts.add(partID)
      if (!partID) entry.metadata = true
      tracker.set(messageID, entry)
    },
    refresh(sessionID: string) {
      const flight = flights.get(sessionID)
      if (!flight) return run(sessionID, "latest")
      flight.again = true
      return flight.promise
    },
    async loadOlder(sessionID: string) {
      const flight = flights.get(sessionID)
      if (flight) return flight.promise
      if (continuations.has(sessionID)) return run(sessionID, "latest")
      if (!state[sessionID]?.initialized || !state[sessionID]?.more) return
      return run(sessionID, "older")
    },
    dispose: () => controller.abort(),
  }
}

export function mergeMessagePage(
  current: SessionMessage[],
  page: SessionMessage[],
  mode: "latest" | "older",
  touches: MessageTouches,
) {
  const existing = new Map(current.map((item) => [item.id, item]))
  const incoming = new Map(
    page.map((item) => [item.id, mergeMessage(existing.get(item.id), item, touches.get(item.id))]),
  )
  if (mode === "older")
    return [
      ...current.map((item) => incoming.get(item.id) ?? item),
      ...[...incoming.values()].filter((item) => !existing.has(item.id)),
    ]
  if (!current.some((item) => incoming.has(item.id))) return [...current, ...incoming.values()]
  const before = new Map<string, SessionMessage[]>()
  let pending: SessionMessage[] = []
  let first: string | undefined
  for (const item of current) {
    if (!incoming.has(item.id)) {
      pending.push(item)
      continue
    }
    first ??= item.id
    before.set(item.id, pending)
    pending = []
  }
  // A snapshot can omit an SSE-only item between two known messages. Preserve
  // its neighbours instead of moving every omitted item behind the whole page.
  const live = (before.get(first!) ?? []).filter((item) => touches.has(item.id))
  const liveIDs = new Set(live.map((item) => item.id))
  return [
    ...live,
    ...[...incoming.values()].flatMap((item) => [
      ...(before.get(item.id) ?? []).filter((row) => !liveIDs.has(row.id)),
      item,
    ]),
    ...pending,
  ]
}

function mergeMessage(current: SessionMessage | undefined, snapshot: SessionMessage, touch?: Touch): SessionMessage {
  if (!current || !touch) return snapshot
  if (current.type !== "assistant" || snapshot.type !== "assistant") return touch.metadata ? current : snapshot
  const parts = new Map(current.content.map((part) => [part.id, part]))
  const seen = new Set(snapshot.content.map((part) => part.id))
  return {
    ...snapshot,
    ...(touch.metadata ? current : {}),
    content: [
      ...snapshot.content.map((part) => (touch.parts.has(part.id) ? (parts.get(part.id) ?? part) : part)),
      ...current.content.filter((part) => !seen.has(part.id)),
    ],
  }
}
