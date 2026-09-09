/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Event, SessionMessage } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { DataProvider, useData } from "../../../src/context/data"
import { SDKProvider } from "../../../src/context/sdk"
import { ProjectProvider } from "../../../src/context/project"
import {
  projectSessionMessagesToLegacy,
  type SessionMessageProjectionCache,
} from "../../../src/context/session-message-projection"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

const sessionID = "ses_history"
const fallback = { agent: "build", directory }
const item = (n: number): SessionMessage => ({
  id: `msg_${9000 - n}`,
  type: "user",
  text: `row ${n}`,
  time: { created: 42 },
})

async function wait(fn: () => boolean) {
  const deadline = Date.now() + 3000
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition timed out")
    await Bun.sleep(5)
  }
}

async function fixture(persisted: SessionMessage[]) {
  const events = createEventSource()
  const queries: URLSearchParams[] = []
  const control: { fail?: boolean; failOnRead?: number; hold?: boolean; release?: () => void } = {}
  const calls = createFetch((url) => {
    if (!url.pathname.startsWith("/api/session/") || !url.pathname.endsWith("/message")) return
    queries.push(url.searchParams)
    if (control.fail || control.failOnRead === queries.length) return new Response("unavailable", { status: 503 })
    const cursor = url.searchParams.get("cursor")
    const end = cursor ? persisted.findIndex((row) => row.id === cursor) : persisted.length
    const limit = Number(url.searchParams.get("limit"))
    const data = structuredClone(persisted.slice(Math.max(0, end - limit), end).toReversed())
    const response = { data, cursor: { next: data.at(-1)?.id } }
    if (control.hold)
      return new Promise<Response>((resolve) => {
        control.release = () => resolve(json(response))
      })
    return json(response)
  }, events)
  let data!: ReturnType<typeof useData>
  function Probe() {
    data = useData()
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))
  await wait(() => Boolean(data))
  return {
    data,
    control,
    queries,
    app,
    emit(payload: Event) {
      events.emit({ directory, project: "proj_test", payload })
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

for (const count of [0, 50, 100, 101, 350])
  test(`pages ${count} durable records to the actual beginning`, async () => {
    const rows = Array.from({ length: count }, (_, n) => item(n))
    using ctx = await fixture(rows)
    const messages = ctx.data.session.message
    await messages.refresh(sessionID)
    expect(messages.list(sessionID)?.length).toBe(Math.min(100, count))
    while (messages.history(sessionID).more) await messages.loadOlder(sessionID)
    expect(messages.list(sessionID)?.map((row) => row.id)).toEqual(rows.toReversed().map((row) => row.id))
    const projected = projectSessionMessagesToLegacy(sessionID, messages.list(sessionID)!, fallback)
    expect(projected.messages.map((row) => row.id)).toEqual(rows.map((row) => row.id))
    expect(ctx.queries.length).toBe(Math.floor(count / 100) + 1)
    expect(ctx.queries[0].get("order")).toBe("desc")
    expect(ctx.queries.every((query) => query.get("limit") === "100")).toBe(true)
    expect(ctx.queries.slice(1).every((query) => query.has("cursor") && !query.has("order"))).toBe(true)
    await messages.refresh(sessionID)
    expect(messages.list(sessionID)?.length).toBe(count)
  })

test("reconnect bridges more than a page, including a newer live overlap, and retains the older boundary", async () => {
  const rows = Array.from({ length: 350 }, (_, n) => item(n))
  using ctx = await fixture(rows)
  const messages = ctx.data.session.message
  await messages.refresh(sessionID)
  await messages.loadOlder(sessionID)
  const cursor = messages.history(sessionID).cursor
  rows.push(...Array.from({ length: 150 }, (_, n) => item(n + 350)))
  ctx.emit({
    id: "evt_latest",
    type: "session.next.prompted",
    properties: {
      sessionID,
      messageID: rows.at(-1)!.id,
      timestamp: 42,
      prompt: { text: "row 499" },
      delivery: "queue",
    },
  } as Event)
  await wait(() => messages.list(sessionID)?.[0]?.id === rows.at(-1)!.id)
  await messages.refresh(sessionID)
  expect(messages.list(sessionID)?.length).toBe(350)
  expect(messages.history(sessionID).cursor).toBe(cursor)
  while (messages.history(sessionID).more) await messages.loadOlder(sessionID)
  expect(messages.list(sessionID)?.map((row) => row.id)).toEqual(rows.toReversed().map((row) => row.id))
})

test("a late snapshot preserves the live prompt, text and completion while filling untouched parts", async () => {
  const assistant: SessionMessage = {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "fixture", providerID: "test" },
    time: { created: 43 },
    content: [{ id: "text", type: "text", text: "old" }],
  }
  const rows = [item(0), assistant]
  using ctx = await fixture(rows)
  const messages = ctx.data.session.message
  await messages.refresh(sessionID)
  assistant.content.push({ id: "missed", type: "text", text: "snapshot fills missing part" })
  ctx.control.hold = true
  const refresh = messages.refresh(sessionID)
  await wait(() => !!ctx.control.release)
  ctx.emit({
    id: "evt_text",
    type: "session.next.text.delta",
    properties: {
      sessionID,
      assistantMessageID: assistant.id,
      textID: "text",
      delta: " and live",
      timestamp: 44,
    },
  } as Event)
  ctx.emit({
    id: "evt_end",
    type: "session.next.step.ended",
    properties: {
      sessionID,
      assistantMessageID: assistant.id,
      timestamp: 45,
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  } as Event)
  ctx.emit({
    id: "evt_prompt",
    type: "session.next.prompted",
    properties: {
      sessionID,
      messageID: "msg_live",
      timestamp: 46,
      prompt: { text: "live prompt" },
      delivery: "queue",
    },
  } as Event)
  await wait(() => messages.list(sessionID)?.[0]?.id === "msg_live")
  ctx.control.release!()
  await refresh
  expect(messages.list(sessionID)?.[0]?.id).toBe("msg_live")
  const result = messages.list(sessionID)?.find((row) => row.id === assistant.id)
  expect(JSON.parse(JSON.stringify(result))).toMatchObject({
    time: { completed: 45 },
    finish: "stop",
    content: [
      { id: "text", text: "old and live" },
      { id: "missed", text: "snapshot fills missing part" },
    ],
  })
})

test("older page failure is retryable and concurrent loads are coalesced", async () => {
  using ctx = await fixture(Array.from({ length: 350 }, (_, n) => item(n)))
  const messages = ctx.data.session.message
  await messages.refresh(sessionID)
  const cursor = messages.history(sessionID).cursor
  ctx.control.fail = true
  await expect(messages.loadOlder(sessionID)).rejects.toBeDefined()
  expect(messages.history(sessionID)).toMatchObject({ cursor, more: true })
  expect(messages.history(sessionID).error).toBeDefined()
  expect(messages.list(sessionID)?.length).toBe(100)
  ctx.control.fail = false
  ctx.control.hold = true
  const first = messages.loadOlder(sessionID)
  await wait(() => !!ctx.control.release)
  const second = messages.loadOlder(sessionID)
  ctx.control.release!()
  await Promise.all([first, second])
  expect(messages.list(sessionID)?.length).toBe(200)
  expect(ctx.queries.length).toBe(3)
})

test("a refresh requested during an old read performs a trailing read", async () => {
  const rows = [item(0)]
  using ctx = await fixture(rows)
  const messages = ctx.data.session.message
  ctx.control.hold = true
  const initial = messages.refresh(sessionID)
  await wait(() => !!ctx.control.release)
  rows.push(item(1))
  const terminal = messages.refresh(sessionID)
  ctx.control.hold = false
  ctx.control.release!()
  await Promise.all([initial, terminal])
  expect(messages.list(sessionID)?.length).toBe(2)
  expect(ctx.queries.length).toBe(2)
})

test("an initially empty session gains an older cursor when its later snapshot fills a page", async () => {
  const rows: SessionMessage[] = []
  using ctx = await fixture(rows)
  const messages = ctx.data.session.message
  await messages.refresh(sessionID)
  rows.push(...Array.from({ length: 150 }, (_, n) => item(n)))
  await messages.refresh(sessionID)
  expect(messages.history(sessionID).more).toBe(true)
  await messages.loadOlder(sessionID)
  expect(messages.list(sessionID)?.length).toBe(150)
})

test("hidden records still advance raw paging to an earlier visible user", async () => {
  const rows: SessionMessage[] = [
    item(0),
    ...Array.from(
      { length: 300 },
      (_, n): SessionMessage => ({
        id: `system_${n}`,
        type: "system",
        text: "hidden context",
        time: { created: n },
      }),
    ),
  ]
  using ctx = await fixture(rows)
  const messages = ctx.data.session.message
  await messages.refresh(sessionID)
  expect(projectSessionMessagesToLegacy(sessionID, messages.list(sessionID)!, fallback).messages).toEqual([])
  while (messages.history(sessionID).more) await messages.loadOlder(sessionID)
  expect(
    projectSessionMessagesToLegacy(sessionID, messages.list(sessionID)!, fallback).messages.map((x) => x.id),
  ).toEqual([item(0).id])
  expect(ctx.queries.length).toBe(4)
})

test("a failed reconnect resumes its missing interval and then reads the current head", async () => {
  const rows = Array.from({ length: 150 }, (_, n) => item(n))
  using ctx = await fixture(rows)
  const messages = ctx.data.session.message
  await messages.refresh(sessionID)
  rows.push(...Array.from({ length: 250 }, (_, n) => item(n + 150)))
  ctx.control.failOnRead = 3
  await expect(messages.refresh(sessionID)).rejects.toBeDefined()
  expect(messages.history(sessionID).failed).toBe("latest")
  expect(messages.list(sessionID)?.length).toBe(100)
  const failedCursor = ctx.queries[2].get("cursor")
  rows.push(item(400))
  await messages.refresh(sessionID)
  expect(ctx.queries[3].get("cursor")).toBe(failedCursor)
  expect(ctx.queries.at(-1)?.get("order")).toBe("desc")
  expect(messages.list(sessionID)?.[0]?.id).toBe(item(400).id)
  while (messages.history(sessionID).more) await messages.loadOlder(sessionID)
  expect(messages.list(sessionID)?.map((x) => x.id)).toEqual(rows.toReversed().map((x) => x.id))
})

test("a failed in-flight read does not swallow an already requested terminal refresh", async () => {
  using ctx = await fixture([item(0)])
  ctx.control.failOnRead = 1
  const initial = ctx.data.session.message.refresh(sessionID)
  const terminal = ctx.data.session.message.refresh(sessionID)
  await Promise.all([initial, terminal])
  expect(ctx.queries.length).toBe(2)
  expect(ctx.data.session.message.list(sessionID)?.length).toBe(1)
  expect(ctx.data.session.message.history(sessionID).error).toBeUndefined()
})

test("projection retains unchanged objects with 2,000 loaded messages and repairs the page boundary parent", () => {
  const rows = Array.from({ length: 2000 }, (_, n) => item(n)).toReversed()
  const cache: SessionMessageProjectionCache = new Map()
  const initial = projectSessionMessagesToLegacy(sessionID, rows, fallback, cache)
  const updated = projectSessionMessagesToLegacy(sessionID, rows, fallback, cache, (id) => (id === rows[0].id ? 1 : 0))
  expect(updated.changed.size).toBe(1)
  expect(updated.messages[0]).toBe(initial.messages[0])
  expect(updated.parts[rows[100].id]).toBe(initial.parts[rows[100].id])
  const assistant: SessionMessage = {
    id: "assistant",
    type: "assistant",
    agent: "build",
    model: { id: "fixture", providerID: "test" },
    time: { created: 1 },
    content: [],
  }
  const first = projectSessionMessagesToLegacy(sessionID, [assistant], fallback, cache)
  const next = projectSessionMessagesToLegacy(sessionID, [assistant, item(0)], fallback, cache)
  expect(first.messages[0]).toHaveProperty("parentID", "assistant")
  expect(next.messages[1]).toHaveProperty("parentID", item(0).id)
})

test("a late history response only updates its originating session", async () => {
  using ctx = await fixture([item(0)])
  ctx.control.hold = true
  const old = ctx.data.session.message.refresh(sessionID)
  await wait(() => !!ctx.control.release)
  ctx.control.hold = false
  await ctx.data.session.message.refresh("ses_other")
  const other = ctx.data.session.message.list("ses_other")
  ctx.control.release!()
  await old
  expect(ctx.data.session.message.list("ses_other")).toBe(other)
  expect(ctx.data.session.message.history("ses_other").loading).toBeUndefined()
})
