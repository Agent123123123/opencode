import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import {
  MOTRYX_STARTUP_COLORS,
  MOTRYX_TERMINAL_ICON,
  MOTRYX_TERMINAL_ICON_COMPACT,
  motryxStartupLayout,
} from "../ic-agent/motryx-startup"
import { Spinner } from "./spinner"

function MotryxTerminalIcon(props: { compact: boolean }) {
  const pixels = () => (props.compact ? MOTRYX_TERMINAL_ICON_COMPACT : MOTRYX_TERMINAL_ICON)
  const color = (pixel: string) => {
    if (pixel === "M") return MOTRYX_STARTUP_COLORS.cream
    if (pixel === "m") return MOTRYX_STARTUP_COLORS.creamEdge
    if (pixel === "X") return MOTRYX_STARTUP_COLORS.gold
    if (pixel === "x") return MOTRYX_STARTUP_COLORS.goldEdge
    return MOTRYX_STARTUP_COLORS.shell
  }

  return (
    <box flexDirection="column">
      <For each={Array.from({ length: pixels().length / 2 })}>
        {(_, row) => (
          <box flexDirection="row">
            <For each={pixels()[row() * 2].split("")}>
              {(upper, column) => (
                <text fg={color(upper)} bg={color(pixels()[row() * 2 + 1][column()])} selectable={false}>
                  ▀
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

export function StartupLoading(props: {
  ready: () => boolean
  product?: boolean
  status?: () => string
}) {
  const theme = useTheme().theme
  const dimensions = useTerminalDimensions()
  const product = () => props.product === true
  const [show, setShow] = createSignal(product())
  const text = createMemo(() => {
    if (props.ready()) return "Finishing startup..."
    return props.status?.() ?? "Loading plugins..."
  })
  const layout = createMemo(() => motryxStartupLayout(dimensions().width, dimensions().height))
  const showWordmark = createMemo(
    () => layout() !== "minimal" || (dimensions().width >= 6 && dimensions().height >= 2),
  )
  const showWordmarkGap = createMemo(() => layout() !== "minimal" || dimensions().height >= 3)
  const startupText = createMemo(() => {
    if (layout() !== "minimal") return text()
    if (dimensions().width < 10) return undefined
    return props.ready() ? "Ready" : "Starting"
  })
  let wait: NodeJS.Timeout | undefined
  let hold: NodeJS.Timeout | undefined
  let stamp = product() ? Date.now() : 0

  createEffect(() => {
    if (props.ready()) {
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      if (!show()) return
      if (hold) return

      const minimum = product() ? 600 : 3000
      const left = minimum - (Date.now() - stamp)
      if (left <= 0) {
        setShow(false)
        return
      }

      hold = setTimeout(() => {
        hold = undefined
        setShow(false)
      }, left).unref()
      return
    }

    if (hold) {
      clearTimeout(hold)
      hold = undefined
    }
    if (show()) return
    if (wait) return

    const delay = product() ? 0 : 500
    wait = setTimeout(() => {
      wait = undefined
      stamp = Date.now()
      setShow(true)
    }, delay).unref()
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
    if (hold) clearTimeout(hold)
  })

  return (
    <Show when={show()}>
      <Show
        when={product()}
        fallback={
          <box
            position="absolute"
            zIndex={5000}
            left={0}
            right={0}
            bottom={1}
            justifyContent="center"
            alignItems="center"
          >
            <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
              <Spinner color={theme.textMuted}>{text()}</Spinner>
            </box>
          </box>
        }
      >
        <box
          position="absolute"
          zIndex={5000}
          top={0}
          right={0}
          bottom={0}
          left={0}
          backgroundColor={MOTRYX_STARTUP_COLORS.shell}
          justifyContent="center"
          alignItems="center"
          flexDirection="column"
        >
          <Show when={layout() !== "minimal"}>
            <MotryxTerminalIcon compact={layout() === "compact"} />
            <box height={layout() === "compact" ? 1 : 2} />
          </Show>
          <Show when={showWordmark()}>
            <text fg={MOTRYX_STARTUP_COLORS.cream} attributes={TextAttributes.BOLD} selectable={false}>
              MOTRYX
            </text>
          </Show>
          <Show when={showWordmarkGap()}>
            <box height={1} />
          </Show>
          <Spinner color={RGBA.fromHex(MOTRYX_STARTUP_COLORS.gold)}>{startupText()}</Spinner>
          <Show when={layout() === "standard"}>
            <box height={1} />
            <text fg={MOTRYX_STARTUP_COLORS.muted} selectable={false}>
              Agent workflow runtime
            </text>
          </Show>
        </box>
      </Show>
    </Show>
  )
}
