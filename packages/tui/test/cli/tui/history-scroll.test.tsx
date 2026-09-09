/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createSignal, For, onCleanup } from "solid-js"
import { attachHistoryScroll } from "../../../src/routes/session/history-scroll"

const rows = (start: number, length: number) =>
  Array.from({ length }, (_, i) => ({ id: `row-${start + i}`, text: `ROW ${start + i}` }))

async function fixture() {
  const [items, setItems] = createSignal(rows(100, 50))
  let scroll!: ScrollBoxRenderable
  let history!: ReturnType<typeof attachHistoryScroll>
  let reads = 0
  let release: (() => void) | undefined
  const state = { more: true, loading: undefined as string | undefined }
  function Probe() {
    const renderer = useRenderer()
    onCleanup(() => history.dispose())
    return (
      <scrollbox
        height={8}
        verticalScrollbarOptions={{ visible: false }}
        stickyScroll
        stickyStart="bottom"
        ref={(value) => {
          scroll = value
          history = attachHistoryScroll(value, renderer, {
            state: () => state,
            loadOlder: async () => {
              reads++
              state.loading = "older"
              await new Promise<void>((resolve) => {
                release = resolve
              })
              setItems((current) => [...rows(0, 100), ...current])
              state.loading = undefined
              state.more = false
            },
          })
        }}
      >
        <For each={items()}>
          {(item) => (
            <text id={item.id} height={1}>
              {item.text}
            </text>
          )}
        </For>
      </scrollbox>
    )
  }
  const app = await testRender(Probe, { width: 50, height: 12 })
  await app.renderOnce()
  await app.renderOnce()
  return {
    app,
    scroll,
    history,
    setItems,
    items,
    state,
    get reads() {
      return reads
    },
    release: () => release?.(),
    async frame() {
      await app.renderOnce()
      await app.renderOnce()
      return app.captureCharFrame()
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
    },
  }
}

test("a prepend and concurrent tail append preserve the visible item, not a height delta", async () => {
  using ctx = await fixture()
  ctx.scroll.scrollTo(5)
  ctx.history.up()
  const before = await ctx.frame()
  expect(before).toContain("ROW 105")
  ctx.setItems((items) => [...rows(0, 100), ...items, ...rows(150, 20)])
  const after = await ctx.frame()
  expect(after).toBe(before)
  expect(ctx.scroll.scrollTop).toBe(105)
})

test("reading position changes during a page request supersede its initial anchor", async () => {
  using ctx = await fixture()
  ctx.scroll.scrollTo(0)
  ctx.history.up()
  expect(ctx.reads).toBe(1)
  ctx.scroll.scrollTo(10)
  const before = await ctx.frame()
  ctx.release()
  await Promise.resolve()
  expect(await ctx.frame()).toBe(before)
  expect(ctx.scroll.scrollTop).toBe(110)
  expect(ctx.reads).toBe(1)
})

test("End during a pending page remains at the bottom after it arrives", async () => {
  using ctx = await fixture()
  ctx.scroll.scrollTo(0)
  ctx.history.up()
  ctx.history.bottom()
  ctx.scroll.scrollTo(ctx.scroll.scrollHeight)
  ctx.release()
  await Promise.resolve()
  await ctx.frame()
  expect(ctx.scroll.scrollTop).toBe(ctx.scroll.scrollHeight - ctx.scroll.viewport.height)
  expect(ctx.app.captureCharFrame()).toContain("ROW 149")
})

test("bottom follows new output; mounting does not eagerly load all history", async () => {
  using ctx = await fixture()
  ctx.setItems((items) => [...items, ...rows(150, 10)])
  expect(await ctx.frame()).toContain("ROW 159")
  expect(ctx.reads).toBe(0)
})

test("disposing a view during an older-page request removes its scroll restoration", async () => {
  using ctx = await fixture()
  ctx.scroll.scrollTo(0)
  ctx.history.up()
  ctx.history.dispose()
  ctx.scroll.scrollTo(10)
  ctx.release()
  await Promise.resolve()
  await ctx.frame()
  expect(ctx.scroll.scrollTop).toBe(10)
  expect(ctx.reads).toBe(1)
})

test("two thousand rendered items remain stable while the tail updates", async () => {
  using ctx = await fixture()
  ctx.setItems(rows(0, 2050))
  await ctx.frame()
  ctx.scroll.scrollTo(100)
  ctx.history.up()
  const before = await ctx.frame()
  const children = ctx.scroll.getChildren()
  const durations: number[] = []
  for (let i = 0; i < 50; i++) {
    const start = performance.now()
    ctx.setItems((items) => [...items.slice(0, -1), { id: "row-2049", text: `STREAM ${i}` }])
    await ctx.app.renderOnce()
    durations.push(performance.now() - start)
  }
  expect(ctx.app.captureCharFrame()).toBe(before)
  expect(ctx.scroll.getChildren().slice(0, -1)).toEqual(children.slice(0, -1))
  console.log(
    "history render timings",
    JSON.stringify({
      items: 2050,
      frames: durations.length,
      medianMS: durations.toSorted((a, b) => a - b)[25],
      maxMS: Math.max(...durations),
    }),
  )
})
