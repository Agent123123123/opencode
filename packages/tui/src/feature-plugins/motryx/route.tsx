/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { SessionMessage, SessionV2Info } from "@opencode-ai/sdk/v2"
import path from "node:path"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import {
  motryxControlConfigFromEnv,
  type MotryxControlConfig,
  type MotryxControlSnapshot,
  type MotryxFetcher,
  type MotryxLaneProjection,
} from "./control"
import {
  createMotryxProjectionController,
  type MotryxProjectionPhase,
  type MotryxProjectionState,
} from "./projection-events"
import { motryxProductLayout } from "./layout"

type TranscriptItem = {
  id: string
  role: "user" | "assistant"
  label: string
  text: string
}

export function MotryxRoute(props: {
  api: TuiPluginApi
  config?: MotryxControlConfig
  configError?: string
  fetcher?: MotryxFetcher
  onRefreshAvailable: (refresh?: () => Promise<void>) => void
}) {
  const dimensions = useTerminalDimensions()
  const config = props.config
  const [snapshot, setSnapshot] = createSignal<MotryxControlSnapshot>()
  const [connection, setConnection] = createSignal<MotryxProjectionState>(
    config ? { phase: "connecting" } : { phase: "unbound", detail: props.configError },
  )
  const [conversation, setConversation] = createSignal<{
    session: SessionV2Info
    messages: SessionMessage[]
  }>()
  const [transcriptError, setTranscriptError] = createSignal<string>()
  const layout = createMemo(() => motryxProductLayout(dimensions()))
  const transcript = createMemo(() => projectTranscript(conversation()?.messages ?? []))
  let conversationRead = 0
  let disposed = false

  async function refreshConversation() {
    if (!config) return
    const read = ++conversationRead
    try {
      const [session, messages] = await Promise.all([
        props.api.client.v2.session.get({ sessionID: config.orchestratorSessionID }, { throwOnError: true }),
        props.api.client.v2.session.messages(
          { sessionID: config.orchestratorSessionID, limit: 100, order: "desc" },
          { throwOnError: true },
        ),
      ])
      if (disposed || props.api.lifecycle.signal.aborted || read !== conversationRead) return
      if (session.data.data.id !== config.orchestratorSessionID) {
        throw new Error(`OpenCode returned unexpected session ${session.data.data.id}`)
      }
      if (path.resolve(session.data.data.location.directory) !== config.projectID) {
        throw new Error(`OpenCode session location does not match ${config.projectID}`)
      }
      setConversation({
        session: session.data.data,
        messages: messages.data.data.toReversed(),
      })
      setTranscriptError(undefined)
    } catch (error) {
      if (disposed || props.api.lifecycle.signal.aborted || read !== conversationRead) return
      setTranscriptError(error instanceof Error ? error.message : String(error))
    }
  }

  onMount(() => {
    if (!config) return
    void refreshConversation()
    const offPrompted = props.api.event.on("session.next.prompted", (event) => {
      if (event.properties.sessionID === config.orchestratorSessionID) void refreshConversation()
    })
    const offSettled = props.api.event.on("session.turn.settled", (event) => {
      if (event.properties.sessionID === config.orchestratorSessionID) void refreshConversation()
    })
    const offModel = props.api.event.on("session.next.model.switched", (event) => {
      if (event.properties.sessionID === config.orchestratorSessionID) void refreshConversation()
    })
    const controller = createMotryxProjectionController({
      config,
      fetcher: props.fetcher,
      signal: props.api.lifecycle.signal,
      onSnapshot: setSnapshot,
      onState: setConnection,
    })
    props.onRefreshAvailable(controller.refresh)
    void controller.start()
    onCleanup(() => {
      disposed = true
      conversationRead += 1
      offPrompted()
      offSettled()
      offModel()
      props.onRefreshAvailable(undefined)
      controller.dispose()
    })
  })

  const status = createMemo(() => statusPresentation(connection().phase))
  const workflowWidth = createMemo<number | "100%">(() =>
    layout().direction === "row" ? (layout().workflowWidth ?? 38) : "100%",
  )
  const workflowHeight = createMemo(() => (layout().direction === "column" ? layout().workflowHeight : undefined))

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column" padding={1} gap={1}>
      <box flexShrink={0} flexDirection="row" gap={1}>
        <box flexDirection="row">
          <text fg={props.api.theme.current.text}>MOTRY</text>
          <text fg={props.api.theme.current.warning}>X</text>
        </box>
        <text fg={props.api.theme.current.textMuted}>IC workflow</text>
        <box flexGrow={1} />
        <text fg={statusColor(props.api, connection().phase)}>{status().label}</text>
      </box>

      <Show
        when={layout().mode !== "safe"}
        fallback={
          <box
            flexGrow={1}
            minHeight={0}
            flexDirection="column"
            border={["top", "bottom", "left", "right"]}
            borderColor={props.api.theme.current.border}
            padding={1}
          >
            <text fg={statusColor(props.api, connection().phase)}>{status().label}</text>
            <Show when={connection().detail}>
              {(detail) => <text fg={props.api.theme.current.textMuted}>{detail()}</text>}
            </Show>
            <text fg={props.api.theme.current.textMuted}>Terminal too small.</text>
            <text fg={props.api.theme.current.textMuted}>/motryx-session opens conversation.</text>
          </box>
        }
      >
        <box flexGrow={1} minHeight={0} flexDirection={layout().direction} gap={1}>
          <WorkflowPanel
            api={props.api}
            snapshot={snapshot()}
            state={connection()}
            width={workflowWidth()}
            height={workflowHeight()}
            compact={layout().mode === "conversation-first"}
          />
          <Show when={layout().showTranscript}>
            <TranscriptPanel
              api={props.api}
              session={conversation()?.session}
              items={transcript()}
              sessionID={config?.orchestratorSessionID ?? ""}
              error={transcriptError()}
            />
          </Show>
        </box>
      </Show>

      <box flexShrink={0} flexDirection="row" gap={2}>
        <text fg={props.api.theme.current.textMuted}>/motryx-session conversation</text>
        <text fg={props.api.theme.current.textMuted}>/motryx-refresh projection</text>
        <box flexGrow={1} />
        <Show when={snapshot()}>
          {(value) => (
            <text fg={props.api.theme.current.textMuted}>
              gen {value().binding.bindingGeneration} · {shortRevision(value().projectionRevision)}
            </text>
          )}
        </Show>
      </box>
    </box>
  )
}

function WorkflowPanel(props: {
  api: TuiPluginApi
  snapshot?: MotryxControlSnapshot
  state: MotryxProjectionState
  width: number | "100%"
  height?: number
  compact: boolean
}) {
  const snapshot = () => props.snapshot
  return (
    <box
      width={props.width}
      height={props.height}
      flexGrow={props.height === undefined ? 0 : undefined}
      flexShrink={0}
      minHeight={0}
      flexDirection="column"
      border={["top", "bottom", "left", "right"]}
      borderColor={props.state.phase === "live" ? props.api.theme.current.borderActive : props.api.theme.current.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show
        when={snapshot()}
        fallback={
          <box paddingTop={1}>
            <text fg={statusColor(props.api, props.state.phase)}>{statusPresentation(props.state.phase).label}</text>
            <Show when={props.state.detail}>
              {(detail) => (
                <text fg={props.api.theme.current.textMuted} wrapMode="word">
                  {detail()}
                </text>
              )}
            </Show>
            <text fg={props.api.theme.current.textMuted}>Waiting for an exact ROUTABLE projection.</text>
          </box>
        }
      >
        {(value) => (
          <>
            <box flexShrink={0} flexDirection="row" gap={1}>
              <text fg={props.api.theme.current.text}>Workflow</text>
              <text fg={workflowColor(props.api, value().workflow?.status)}>
                {value().workflow?.status.toLowerCase() ?? "idle"}
              </text>
              <box flexGrow={1} />
              <text fg={props.api.theme.current.textMuted}>
                {value().lanes.length} lanes · {value().agents.length} agents
              </text>
            </box>
            <Show when={!props.compact && value().workflow?.goal}>
              {(goal) => (
                <text fg={props.api.theme.current.textMuted} wrapMode="word">
                  {goal()}
                </text>
              )}
            </Show>
            <scrollbox
              flexGrow={1}
              minHeight={0}
              verticalScrollbarOptions={{ visible: false }}
              horizontalScrollbarOptions={{ visible: false }}
            >
              <Show
                when={value().lanes.length > 0}
                fallback={<text fg={props.api.theme.current.textMuted}>No lanes yet.</text>}
              >
                <For each={value().lanes}>
                  {(lane, index) => (
                    <LaneRow api={props.api} lane={lane} ordinal={index() + 1} compact={props.compact} />
                  )}
                </For>
              </Show>
            </scrollbox>
          </>
        )}
      </Show>
    </box>
  )
}

function LaneRow(props: { api: TuiPluginApi; lane: MotryxLaneProjection; ordinal: number; compact: boolean }) {
  const status = () => props.lane.status.toUpperCase()
  return (
    <box flexDirection="column" paddingBottom={props.compact ? 0 : 1}>
      <box flexDirection="row" gap={1}>
        <text fg={props.api.theme.current.textMuted}>{String(props.ordinal).padStart(2, "0")}</text>
        <text fg={props.api.theme.current.text} truncate>
          {props.lane.name}
        </text>
        <box flexGrow={1} />
        <text fg={laneColor(props.api, status())}>{statusLabel(status())}</text>
      </box>
      <Show when={!props.compact && (props.lane.pendingCheckSummary || props.lane.lastCheckResult)}>
        <text fg={props.api.theme.current.textMuted} wrapMode="word">
          {props.lane.pendingCheckSummary || props.lane.lastCheckResult}
        </text>
      </Show>
    </box>
  )
}

function TranscriptPanel(props: {
  api: TuiPluginApi
  session?: SessionV2Info
  items: TranscriptItem[]
  sessionID: string
  error?: string
}) {
  const model = () => props.session?.model
  return (
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      flexDirection="column"
      border={["top", "bottom", "left", "right"]}
      borderColor={props.api.theme.current.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexShrink={0} flexDirection="row" gap={1}>
        <text fg={props.api.theme.current.text}>Orchestrator</text>
        <text fg={props.api.theme.current.textMuted} truncate>
          {props.session?.title ?? props.sessionID}
        </text>
        <box flexGrow={1} />
        <Show when={model()}>
          {(value) => (
            <text fg={props.api.theme.current.textMuted}>
              {props.session?.agent ?? "agent"} · {value().providerID}/{value().id}
            </text>
          )}
        </Show>
      </box>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{ visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <Show
          when={props.items.length > 0}
          fallback={
            <text fg={props.api.theme.current.textMuted}>
              {props.error ? `OpenCode conversation unavailable: ${props.error}` : "No visible conversation text yet."}
            </text>
          }
        >
          <For each={props.items}>
            {(item) => (
              <box flexDirection="column" paddingBottom={1}>
                <text fg={item.role === "user" ? props.api.theme.current.accent : props.api.theme.current.secondary}>
                  {item.label}
                </text>
                <text fg={props.api.theme.current.text} wrapMode="word">
                  {item.text}
                </text>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  )
}

export function projectTranscript(
  messages: readonly SessionMessage[],
): TranscriptItem[] {
  return messages
    .flatMap((message) => {
      if (message.type !== "user" && message.type !== "assistant") return []
      const text =
        message.type === "user"
          ? message.text
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
      const visible = sanitizeTranscript(text)
      if (!visible) return []
      return [
        {
          id: message.id,
          role: message.type,
          label: message.type === "user" ? "you" : message.agent || "assistant",
          text: visible,
        } satisfies TranscriptItem,
      ]
    })
    .slice(-16)
}

const INTERNAL_LOG = [
  /\bruntime_liveness\b/i,
  /\bwake_ack\b/i,
  /\bwake_id=/i,
  /\bsession_title=\[/i,
  /\bliveness recovery\b/i,
]

const INTERNAL_MESSAGE = [/^\s*<ic_agent_wakeup>/i, /^\s*<active-inbox-item>/i]

function sanitizeTranscript(value: string) {
  if (INTERNAL_MESSAGE.some((pattern) => pattern.test(value))) return
  const text = value
    .trim()
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_LOG.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim()
  return text || undefined
}

function statusPresentation(phase: MotryxProjectionPhase) {
  if (phase === "live") return { label: "ROUTABLE" }
  if (phase === "connecting") return { label: "CONNECTING" }
  if (phase === "starting") return { label: "RECONCILING" }
  if (phase === "auth-error") return { label: "AUTH ERROR" }
  if (phase === "schema-error") return { label: "SCHEMA ERROR" }
  if (phase === "unbound") return { label: "UNBOUND" }
  if (phase === "disposed") return { label: "CLOSED" }
  return { label: "STALE" }
}

function statusColor(api: TuiPluginApi, phase: MotryxProjectionPhase) {
  if (phase === "live") return api.theme.current.success
  if (phase === "connecting" || phase === "starting") return api.theme.current.warning
  if (phase === "disposed") return api.theme.current.textMuted
  return api.theme.current.error
}

function workflowColor(api: TuiPluginApi, status?: string) {
  if (!status) return api.theme.current.textMuted
  if (["done", "complete", "completed"].includes(status.toLowerCase())) return api.theme.current.success
  if (["blocked", "failed", "error"].includes(status.toLowerCase())) return api.theme.current.error
  return api.theme.current.info
}

function laneColor(api: TuiPluginApi, status: string) {
  if (status === "DONE") return api.theme.current.success
  if (status === "BLOCKED") return api.theme.current.error
  if (status === "PENDING" || status === "CHECKING" || status === "AWAITING_CHECK") return api.theme.current.warning
  if (status === "WORKING") return api.theme.current.info
  return api.theme.current.textMuted
}

function statusLabel(status: string) {
  if (status === "AWAITING_CHECK") return "AWAIT CHECK"
  return status.replaceAll("_", " ")
}

function shortRevision(value: string) {
  const revision = value.split(":").at(-1) ?? value
  return revision.slice(0, 8)
}

export function motryxRouteConfig(env: Record<string, string | undefined> = process.env) {
  return motryxControlConfigFromEnv(env)
}
