import { Show } from "solid-js"
import type { IcArtifactPreview } from "../../ic-agent/artifact"
import type { IcArtifactSummary } from "../../ic-agent/projection"
import { Locale } from "../../util/locale"
import { motryx } from "./motryx-theme"

export function ArtifactPreviewPanel(props: {
  artifact: IcArtifactSummary
  preview?: IcArtifactPreview
  loading: boolean
  compact: boolean
  onBack: () => void
}) {
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={motryx.ink} wrapMode="none"><b>{Locale.truncate(props.artifact.title, props.compact ? 22 : 34)}</b></text>
        <box paddingLeft={1} paddingRight={1} backgroundColor={motryx.panelAlt} onMouseDown={props.onBack}>
          <text fg={motryx.gold} wrapMode="none">Back</text>
        </box>
      </box>
      <text fg={motryx.muted} wrapMode="none">
        {Locale.truncate(`${props.artifact.kind} · ${props.artifact.locatorRef ?? props.artifact.path}`, props.compact ? 30 : 44)}
      </text>
      <Show when={!props.loading} fallback={<text fg={motryx.muted}>Loading preview...</text>}>
        <Show
          when={props.preview?.available}
          fallback={<text fg={motryx.redDark} wrapMode="word">{props.preview?.error ?? props.artifact.snapshotError ?? "Preview unavailable"}</text>}
        >
          <text fg={motryx.ink} wrapMode="word">{props.preview?.content ?? ""}</text>
        </Show>
      </Show>
    </box>
  )
}
