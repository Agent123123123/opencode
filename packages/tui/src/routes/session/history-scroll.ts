import { CliRenderEvents, LayoutEvents, type CliRenderer, type ScrollBoxRenderable } from "@opentui/core"

/** Add history anchoring to OpenTUI's own sticky/manual scrolling. */
export function attachHistoryScroll(
  scroll: ScrollBoxRenderable,
  renderer: CliRenderer,
  input: {
    state: () => { more: boolean; loading?: string; error?: string }
    loadOlder: () => Promise<void>
  },
) {
  let anchor: { id: string; offset: number } | undefined
  let layout = false
  let restoring = false
  let demand = false
  let disposed = false
  let previous = scroll.scrollTop

  const capture = () => {
    if (scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height - 1) {
      anchor = undefined
      return
    }
    const child = scroll
      .getChildren()
      .find(
        (child) =>
          child.visible &&
          child.id !== "history-boundary" &&
          child.getLayoutNode().getComputedLayout().top + child.height > scroll.scrollTop,
      )
    anchor = child
      ? { id: child.id, offset: child.getLayoutNode().getComputedLayout().top - scroll.scrollTop }
      : undefined
  }
  const restore = () => {
    if (!anchor || disposed || scroll.isDestroyed) return
    const child = scroll.getChildren().find((child) => child.id === anchor!.id && child.visible)
    if (!child) return
    restoring = true
    // Yoga has finished, but the scrollbars may still have the previous range.
    // Set their public geometry before restoring, just as ScrollBox does on resize.
    scroll.verticalScrollBar.scrollSize = scroll.content.getLayoutNode().getComputedLayout().height
    scroll.verticalScrollBar.viewportSize = scroll.viewport.getLayoutNode().getComputedLayout().height
    scroll.scrollTo(child.getLayoutNode().getComputedLayout().top - anchor.offset)
    previous = scroll.scrollTop
    restoring = false
  }
  const load = () => {
    if (
      disposed ||
      !demand ||
      scroll.scrollTop > 2 ||
      !input.state().more ||
      input.state().loading ||
      input.state().error
    )
      return
    void input.loadOlder().catch(() => {}) // The provider retains the error for the history retry affordance.
  }
  const change = () => {
    if (layout || restoring || disposed) return
    const next = scroll.scrollTop
    if (next < previous) demand = true
    if (next > previous) demand = false
    previous = next
    capture()
    load()
  }
  const before = async () => {
    layout = true
  }
  const after = () => {
    layout = false
    previous = scroll.scrollTop
    // Fallback for content visibility changes that do not change total height.
    restore()
    load()
  }
  renderer.setFrameCallback(before)
  renderer.root.on(LayoutEvents.LAYOUT_CHANGED, restore)
  scroll.content.on("resize", restore)
  scroll.viewport.on("resize", restore)
  scroll.verticalScrollBar.on("change", change)
  renderer.on(CliRenderEvents.FRAME, after)
  return {
    up() {
      demand = true
      capture()
      load()
    },
    down() {
      demand = false
      capture()
    },
    retry() {
      demand = true
      capture()
      if (!input.state().loading) void input.loadOlder().catch(() => {})
    },
    bottom() {
      demand = false
      anchor = undefined
    },
    dispose() {
      disposed = true
      renderer.removeFrameCallback(before)
      renderer.root.off(LayoutEvents.LAYOUT_CHANGED, restore)
      scroll.content.off("resize", restore)
      scroll.viewport.off("resize", restore)
      scroll.verticalScrollBar.off("change", change)
      renderer.off(CliRenderEvents.FRAME, after)
    },
  }
}
