import { For, Show } from "solid-js"
import type { IcAttentionItem } from "../../ic-agent/projection"
import { Locale } from "../../util/locale"
import { motryx } from "./motryx-theme"

export function AttentionStrip(props: {
  items: IcAttentionItem[]
  compact: boolean
  onSelectLane: (laneID: string) => void
}) {
  return (
    <Show when={props.items.length > 0}>
      <box flexDirection="column" gap={0} paddingBottom={1}>
        <For each={props.items}>
          {(item) => (
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={motryx.panelAlt}
              border={["left"]}
              borderColor={item.severity === "error" ? motryx.redDark : motryx.gold}
              onMouseDown={() => item.laneID && props.onSelectLane(item.laneID)}
            >
              <text fg={item.severity === "error" ? motryx.redDark : motryx.gold} wrapMode="none">
                {Locale.truncate(item.title, props.compact ? 28 : 42)}
              </text>
              <text fg={motryx.muted} wrapMode="none">
                {Locale.truncate(item.detail, props.compact ? 28 : 42)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
