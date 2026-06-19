import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useBindings } from "../../keymap"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useLocal } from "../../context/local"
import { useTuiConfig } from "../../config"
import { getScrollAcceleration } from "../../util/scroll"
import { Toast, useToast } from "../../ui/toast"
import { SplitBorder } from "../../ui/border"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { laneBoardLayout } from "../../ic-agent/lane-board-layout"
import { motryxLogoLines, motryxLogoVariant, type MotryxLogoSegment, type MotryxLogoSize } from "../../ic-agent/motryx-logo"
import { motryxReadinessFromEnv, type MotryxReadinessItem } from "../../ic-agent/readiness"
import { motryxSessionModeFromEnv, shouldAutoStartOrchestrator } from "../../ic-agent/session-mode"
import { readMotryxSessionHistory, type MotryxSessionHistoryItem } from "../../ic-agent/session-history"
import { subscribeToWorkflowEvents, workflowEventsTokenFromEnv, workflowEventsURLFromEnv } from "../../ic-agent/workflow-events"
import { resolveMotryxProjectContext } from "../../ic-agent/project-context"
import {
  createMotryxOrchestratorSessionID,
  ensureMotryxOrchestratorBinding,
} from "../../ic-agent/orchestrator-binding"
import {
  projectIcTui,
  type IcArtifactSummary,
  type IcLaneBoardRow,
  type IcLaneSummary,
  type IcSessionSummary,
} from "../../ic-agent/projection"
import { readIcWorkflowSnapshot } from "../../ic-agent/workflow-adapter"
import { icCommandSpecs, type IcCommandIntent, type IcSidecardMode } from "../../ic-agent/commands"
import { SessionSurface } from "../session"
import { motryx, type MotryxPalette } from "./motryx-theme"

const WORKFLOW_REFRESH_INTERVAL_MS = 2000
const SIDECARD_MODES: IcSidecardMode[] = ["workflow", "detail"]

export function IcAgent() {
  const renderer = useRenderer()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const sessionMode = createMemo(() => motryxSessionModeFromEnv())
  const [selectedSessionID, setSelectedSessionID] = createSignal(process.env.MOTRYX_RESUME_SESSION || "")
  const [selectedLaneID, setSelectedLaneID] = createSignal("")
  const [sidecardMode, setSidecardMode] = createSignal<IcSidecardMode>("workflow")
  const [startingSession, setStartingSession] = createSignal(false)
  const [autoStartAttempted, setAutoStartAttempted] = createSignal(false)
  const workflowDirectory = createMemo(() => sync.path.directory || sync.path.worktree || "")
  const projectContext = createMemo(() => resolveMotryxProjectContext({
    projectDir: workflowDirectory(),
    selectedSessionID: selectedSessionID(),
  }))
  const workflowEventsURL = createMemo(() => workflowEventsURLFromEnv())
  const workflowEventsToken = createMemo(() => workflowEventsTokenFromEnv())
  const [workflow, { refetch: refetchWorkflow }] = createResource(
    projectContext,
    (context) => readIcWorkflowSnapshot(context.projectDir, { projectContext: context }),
  )
  const refreshTimer = setInterval(() => {
    if (!workflowDirectory()) return
    if (workflow.loading) return
    void refetchWorkflow()
  }, WORKFLOW_REFRESH_INTERVAL_MS)
  refreshTimer.unref?.()
  onCleanup(() => clearInterval(refreshTimer))
  let unsubscribeWorkflowEvents: (() => void) | undefined
  createEffect(() => {
    const url = workflowEventsURL()
    unsubscribeWorkflowEvents?.()
    unsubscribeWorkflowEvents = undefined
    if (!url) return
    unsubscribeWorkflowEvents = subscribeToWorkflowEvents({
      url,
      token: workflowEventsToken(),
      onEvent: (event) => {
        if (!shouldRefreshFromWorkflowEvent(event.event)) return
        if (!workflowDirectory()) return
        if (workflow.loading) return
        void refetchWorkflow()
      },
    })
  })
  onCleanup(() => unsubscribeWorkflowEvents?.())
  const model = createMemo(() =>
    projectIcTui({
      sessions: sync.data.session,
      messages: sync.data.message,
      parts: sync.data.part,
      statuses: sync.data.session_status,
      selectedSessionID: selectedSessionID(),
      sessionMode: sessionMode(),
      selectedLaneID: selectedLaneID(),
      selectedLaneRole: undefined,
      selectedArtifactID: "",
      workflow: workflow(),
    }),
  )

  const focusSessionID = createMemo(() => model().focusSessionID)
  const compact = createMemo(() => dimensions().width < 100)
  const cockpitScrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const cockpitWidth = createMemo(() => compact() ? Math.max(30, Math.floor(dimensions().width * 0.4)) : 44)
  const logoVariant = createMemo(() => motryxLogoVariant())
  const readiness = createMemo(() => motryxReadinessFromEnv())
  const selectedLane = createMemo(() => model().lanes.find((item) => item.id === model().laneBoard.selectedLaneID))
  const nextAttentionLane = createMemo(() => model().lanes.find((item) => item.id === model().laneBoard.nextAttentionLaneID))
  const boardLayout = createMemo(() => laneBoardLayout({
    terminalHeight: dimensions().height,
    laneCount: model().laneBoard.rows.length,
    hasAttentionHint: Boolean(nextAttentionLane()),
    selectedLaneVisible: Boolean(selectedLane()),
  }))
  const inspectedLane = createMemo(() => selectedLane() ?? model().lanes.find(laneNeedsAttention) ?? model().lanes[0])
  const inspectedLaneIndex = createMemo(() => {
    const lane = inspectedLane()
    if (!lane) return -1
    return model().lanes.findIndex((item) => item.id === lane.id)
  })
  const runIcIntent = (intent: IcCommandIntent) => {
    switch (intent.type) {
      case "start-orchestrator":
        void startOrchestratorSession()
        break
      case "open-sessions":
        void openSessionPicker()
        break
      case "refresh-workflow":
        setSidecardMode("workflow")
        void refreshWorkflowNow()
        break
      case "sidecard":
        setSidecardMode(intent.mode)
        break
      case "focus-lane":
        setSidecardMode("workflow")
        focusLane(intent.laneID)
        break
      case "focus-session":
        setSidecardMode("detail")
        focusSession(intent.sessionID)
        break
    }
  }
  const moveSidecardMode = (direction: 1 | -1) => {
    const index = SIDECARD_MODES.indexOf(sidecardMode())
    const next = index === -1 ? 0 : (index + direction + SIDECARD_MODES.length) % SIDECARD_MODES.length
    setSidecardMode(SIDECARD_MODES[next])
  }
  const moveCockpitFocus = (direction: 1 | -1) => {
    const view = model()
    switch (sidecardMode()) {
      case "workflow":
        focusNeighbor({
          items: view.laneBoard.rows,
          selected: (item) => item.selected,
          select: (item) => focusLane(item.laneID),
          direction,
        })
        break
      case "detail":
        break
    }
  }
  const commandSpecs = createMemo(() => icCommandSpecs(model()))
  useBindings(() => ({
    commands: [
      ...commandSpecs().map((command) => ({
        namespace: "palette",
        name: command.id,
        title: command.title,
        desc: command.description,
        category: command.category,
        slashName: command.slashName,
        slashAliases: command.slashAliases,
        enabled: command.enabled,
        run: () => runIcIntent(command.intent),
      })),
      {
        namespace: "palette",
        name: "ic.cockpit.tab.next",
        title: "Next Motryx cockpit view",
        desc: "Move the Motryx cockpit to the next view.",
        category: "Motryx",
        run: () => moveSidecardMode(1),
      },
      {
        namespace: "palette",
        name: "ic.cockpit.tab.previous",
        title: "Previous Motryx cockpit view",
        desc: "Move the Motryx cockpit to the previous view.",
        category: "Motryx",
        run: () => moveSidecardMode(-1),
      },
      {
        namespace: "palette",
        name: "ic.cockpit.focus.next",
        title: "Next Motryx flow item",
        desc: "Focus the next item in the current Motryx cockpit tab.",
        category: "Motryx",
        run: () => moveCockpitFocus(1),
      },
      {
        namespace: "palette",
        name: "ic.cockpit.focus.previous",
        title: "Previous Motryx flow item",
        desc: "Focus the previous item in the current Motryx cockpit tab.",
        category: "Motryx",
        run: () => moveCockpitFocus(-1),
      },
    ],
  }))
  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: [
      { key: "alt+]", desc: "Next Motryx cockpit view", group: "Motryx", cmd: "ic.cockpit.tab.next" },
      { key: "alt+[", desc: "Previous Motryx cockpit view", group: "Motryx", cmd: "ic.cockpit.tab.previous" },
      { key: "alt+j", desc: "Next Motryx lane row", group: "Motryx", cmd: "ic.cockpit.focus.next" },
      { key: "alt+k", desc: "Previous Motryx lane row", group: "Motryx", cmd: "ic.cockpit.focus.previous" },
    ],
  }))

  const clearFocus = () => {
    setSelectedLaneID("")
    setSelectedSessionID("")
  }
  const focusLane = (laneID: string) => {
    setSelectedLaneID(laneID)
    setSelectedSessionID("")
  }
  const focusSession = (sessionID: string) => {
    setSelectedLaneID("")
    setSelectedSessionID(sessionID)
    ensureBindingForSession(sessionID)
  }
  const ensureBindingForSession = (sessionID: string) => {
    if (!sessionID || !workflowDirectory()) return
    try {
      ensureMotryxOrchestratorBinding({
        projectDir: workflowDirectory(),
        sessionID,
      })
      void refetchWorkflow()
    } catch (error) {
      toast.show({
        message: `Motryx binding failed: ${error instanceof Error ? error.message : String(error)}`,
        variant: "warning",
        duration: 4500,
      })
    }
  }
  const refreshWorkflowNow = async () => {
    await refetchWorkflow()
    toast.show({
      message: "Refreshed Motryx flow",
      variant: "info",
      duration: 2000,
    })
  }
  const openSessionPicker = async () => {
    await sync.session.refresh().catch(() => {})
    const history = await readMotryxSessionHistory({
      projectDir: projectContext().projectDir,
      dbPath: projectContext().motryxSessionDbPath,
    })
    const sessions = history?.sessions.length
      ? history.sessions
      : model().sessions
        .filter((session) => session.role === "orchestrator")
        .map((session, index) => historyItemFromSession(session, index))
    const source = history.sessions.length ? "db" : "sync"
    if (history.status === "error" && sessions.length > 0) {
      toast.show({
        message: "Motryx history DB unavailable; showing loaded sessions",
        variant: "warning",
        duration: 3500,
      })
    }
    if (sessions.length === 0) {
      toast.show({
        message: history.status === "error"
          ? "Motryx history DB unavailable"
          : "No Motryx orchestrator sessions yet",
        variant: history.status === "error" ? "error" : "info",
        duration: 2500,
      })
      return
    }
    dialog.replace(() => (
      <MotryxSessionPicker
        sessions={sessions}
        current={focusSessionID()}
        source={source}
        onSelect={(sessionID) => {
          focusSession(sessionID)
          dialog.clear()
        }}
      />
    ))
  }
  const startOrchestratorSession = async () => {
    if (startingSession()) return
    setStartingSession(true)
    try {
      const model = local.model.current()
      const variant = local.model.variant.current()
      const sessionID = createMotryxOrchestratorSessionID()
      ensureBindingForSession(sessionID)
      const result = await sdk.client.session.create({
        id: sessionID,
        agent: "orchestrator",
        model: model
          ? {
              providerID: model.providerID,
              id: model.modelID,
              variant,
            }
          : undefined,
      })
      if (result.error || !result.data) {
        throw new Error(result.error ? String(result.error) : "Creating session failed")
      }
      focusSession(result.data.id)
      await sync.session.sync(result.data.id).catch(() => {})
      toast.show({
        message: "Started orchestrator session",
        variant: "success",
        duration: 3000,
      })
    } catch (error) {
      toast.show({
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
        duration: 5000,
      })
    } finally {
      setStartingSession(false)
    }
  }
  createEffect(() => {
    if (!shouldAutoStartOrchestrator({
      sessionMode: sessionMode(),
      focusSessionID: focusSessionID(),
      startingSession: startingSession(),
      autoStartAttempted: autoStartAttempted(),
    })) return
    setAutoStartAttempted(true)
    void startOrchestratorSession()
  })
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column" backgroundColor={motryx.shell}>
      <MotryxHeader
        compact={compact()}
        logoVariant={logoVariant()}
      />

      <box flexGrow={1} minHeight={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={motryx.panel}
        >
          <box flexShrink={0} paddingBottom={0}>
            <text fg={motryx.ink} wrapMode="none">
              <b>ORCHESTRATOR</b>
            </text>
          </box>
          <box flexGrow={1} minHeight={0}>
            <SessionSurface
              sessionID={focusSessionID() || undefined}
              width={Math.max(24, dimensions().width - cockpitWidth() - 8)}
              promptRight={<text fg={motryx.gold}>{focusSessionID() ? "orchestrator" : "no session"}</text>}
              empty={(
                <EmptySessionState
                  starting={startingSession()}
                  logoVariant={logoVariant()}
                  readiness={readiness().items}
                  onStart={() => void startOrchestratorSession()}
                />
              )}
            />
          </box>
          <Toast />
        </box>

        <box
          width={cockpitWidth()}
          flexShrink={0}
          minHeight={0}
          flexDirection="column"
          backgroundColor={motryx.panel}
          paddingLeft={1}
          paddingRight={1}
          border={["left"]}
          borderColor={motryx.line}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <CockpitHeader summary={cockpitSummary(model())} compact={compact()} />
          <box flexShrink={0} flexDirection="row" gap={1}>
            <SidecardButton
              label={compact() ? `FLOW ${model().cockpit.counts.lanes}` : "FLOW"}
              selected={sidecardMode() === "workflow"}
              onSelect={() => setSidecardMode("workflow")}
            />
            <SidecardButton
              label="INSPECT"
              selected={sidecardMode() === "detail"}
              onSelect={() => setSidecardMode("detail")}
            />
          </box>
          <scrollbox
            flexGrow={1}
            minHeight={0}
            scrollAcceleration={cockpitScrollAcceleration()}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: motryx.panelAlt,
                foregroundColor: motryx.red,
              },
            }}
          >
            <Switch>
              <Match when={sidecardMode() === "workflow"}>
                <Show
                  when={model().lanes.length > 0}
                  fallback={<WorkflowReadyState model={model()} />}
                >
                  <box flexDirection="column">
                    <AttentionLaneHint lane={nextAttentionLane()} onSelect={(lane) => focusLane(lane.id)} />
                    <LaneBoard
                      rows={model().laneBoard.rows}
                      lanes={model().lanes}
                      compact={compact()}
                      gap={boardLayout().gap}
                      showScrollHint={boardLayout().showScrollHint}
                      onSelectLane={(laneID) => focusLane(laneID)}
                    />
                  </box>
                </Show>
              </Match>
              <Match when={sidecardMode() === "detail"}>
                <box flexDirection="column">
                  <text fg={motryx.ink} wrapMode="none">
                    <b>INSPECT</b>
                  </text>
                  <Show
                    when={inspectedLane()}
                    fallback={<text fg={motryx.muted}>Select a flow row first.</text>}
                  >
                    <LaneDetail
                      lane={inspectedLane()}
                      index={inspectedLaneIndex()}
                      total={model().lanes.length}
                      compact={compact()}
                      rows={model().laneBoard.rows}
                      artifacts={model().artifacts}
                    />
                  </Show>
                </box>
              </Match>
            </Switch>
          </scrollbox>
        </box>
      </box>
      <MotryxStatusBar model={model()} compact={compact()} />
    </box>
  )
}

function focusNeighbor<T>(input: {
  items: T[]
  selected: (item: T) => boolean
  select: (item: T) => void
  direction: 1 | -1
}) {
  if (input.items.length === 0) return
  const index = input.items.findIndex(input.selected)
  const next = index === -1
    ? input.direction === 1 ? 0 : input.items.length - 1
    : (index + input.direction + input.items.length) % input.items.length
  const item = input.items[next]
  if (item) input.select(item)
}

function MotryxHeader(props: {
  compact: boolean
  logoVariant: ReturnType<typeof motryxLogoVariant>
}) {
  return (
    <box
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={motryx.shell}
    >
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <MotryxLogo size="thumb" variant={props.logoVariant} />
          <box flexDirection="column">
            <text fg={motryx.shellText} wrapMode="none">
              <b>Motryx</b>
            </text>
            <text fg={motryx.gold} wrapMode="none">
              {props.compact ? "VIRTUAL SILICON" : "VIRTUAL SILICON ENGINEERS"}
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

function MotryxLogo(props: { size: MotryxLogoSize; variant: ReturnType<typeof motryxLogoVariant> }) {
  const lines = () => motryxLogoLines(props.size, props.variant)
  const color = (tone: MotryxLogoSegment["tone"]) => tone === "gold" ? motryx.gold : motryx.logoGreen
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={lines()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line}>
              {(segment) => <text fg={color(segment.tone)} wrapMode="none">{segment.text}</text>}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

function MotryxStatusBar(props: { model: ReturnType<typeof projectIcTui>; compact: boolean }) {
  const summary = createMemo(() => {
    const counts = props.model.laneBoard.summary
    const blocked = counts.blocked > 0 ? `${counts.blocked} blocked` : "healthy"
    return `${counts.total} lanes · ${blocked}`
  })
  return (
    <box
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={3}
      paddingRight={3}
      backgroundColor={motryx.red}
    >
      <Show
        when={!props.compact}
        fallback={<text fg={motryx.shellText} wrapMode="none">/ flow · alt+j/k lanes · {summary()}</text>}
      >
        <box flexDirection="row" gap={2}>
          <text fg={motryx.shellText} wrapMode="none">esc cancel</text>
          <text fg={motryx.shellText} wrapMode="none">tab focus</text>
          <text fg={motryx.shellText} wrapMode="none">/ flow</text>
          <text fg={motryx.shellText} wrapMode="none">alt+j/k lanes</text>
        </box>
        <text fg={motryx.shellText} wrapMode="none">{summary()}</text>
      </Show>
    </box>
  )
}

function MotryxSessionPicker(props: {
  sessions: MotryxSessionHistoryItem[]
  current: string
  source: "db" | "sync"
  onSelect: (sessionID: string) => void
}) {
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    props.sessions.map((session) => ({
      title: session.title,
      value: session.id,
      description: `${session.updatedText} · msg:${session.messageCount} · ${session.bindingStatus} · ${sessionWorkflowLabel(session)}`,
      details: sessionDetails(session),
      category: "Orchestrator",
    })),
  )
  return (
    <DialogSelect
      title="Motryx sessions"
      options={options()}
      current={props.current}
      onSelect={(option) => props.onSelect(option.value)}
      footerHints={[
        { title: props.source === "db" ? "History" : "Loaded", label: props.source === "db" ? "motryx.db" : "sync" },
        { title: "Start fresh", label: "motryx --new" },
      ]}
    />
  )
}

function sessionWorkflowLabel(session: MotryxSessionHistoryItem) {
  const summary = session.workflowSummary
  if (!summary) return "workflow:unknown"
  if (summary.status === "missing-db") return "workflow:missing-db"
  if (summary.status === "unreadable") return "workflow:unreadable"
  if (summary.status === "empty") return "workflow:empty"
  const active = summary.active > 0 ? `${summary.active} active` : "idle"
  const blocked = summary.blocked > 0 ? `, ${summary.blocked} blocked` : ""
  return `${summary.lanes} lanes (${active}${blocked})`
}

function sessionDetails(session: MotryxSessionHistoryItem) {
  const details = [session.icAgentDbPath ? `${session.handle} · ${session.icAgentDbPath}` : `${session.handle} · ${session.id}`]
  if (session.requiredMigration) {
    details.push(`schema migration required · ${session.requiredMigration}`)
  }
  if (session.workflowSummary?.workflowID) {
    details.push(`${session.workflowSummary.workflowID} · ${session.workflowSummary.workflowStatus ?? "UNKNOWN"}`)
  }
  return details
}

function EmptySessionState(props: {
  starting: boolean
  logoVariant: ReturnType<typeof motryxLogoVariant>
  readiness: MotryxReadinessItem[]
  onStart: () => void
}) {
  return (
    <box flexDirection="column" gap={1} paddingTop={1}>
      <box flexDirection="row" gap={2}>
        <box backgroundColor={motryx.shell} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
          <MotryxLogo size="large" variant={props.logoVariant} />
        </box>
        <box flexDirection="column" paddingTop={1}>
          <text fg={motryx.ink} wrapMode="none">
            <b>Motryx</b>
          </text>
          <text fg={motryx.muted} wrapMode="none">VIRTUAL SILICON ENGINEERS</text>
        </box>
      </box>
      <text fg={motryx.muted} wrapMode="none">No focused orchestrator session.</text>
      <box flexDirection="column">
        <For each={props.readiness.slice(0, 3)}>
          {(item) => (
            <text fg={readinessColor(item)} wrapMode="none">
              {`${item.label}: ${item.detail}`}
            </text>
          )}
        </For>
      </box>
      <box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={motryx.panelAlt}
        border={["left"]}
        borderColor={motryx.red}
        onMouseDown={props.onStart}
      >
        <text fg={motryx.ink} wrapMode="none">
          {props.starting ? "Starting Motryx orchestrator..." : "Start Motryx orchestrator"}
        </text>
        <text fg={motryx.muted} wrapMode="none">or type /orchestrator from the command menu</text>
      </box>
    </box>
  )
}

function historyItemFromSession(session: IcSessionSummary, index: number): MotryxSessionHistoryItem {
  return {
    handle: `@${index + 1}`,
    id: session.id,
    title: session.title,
    agent: "orchestrator",
    updated: session.updated,
    updatedText: formatPickerTime(session.updated),
    messageCount: session.messageCount,
    bindingStatus: "missing-ic-db",
  }
}

function formatPickerTime(updated: number) {
  if (!updated) return "unknown-time"
  const date = new Date(updated)
  if (Number.isNaN(date.getTime())) return "unknown-time"
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  const hour = `${date.getHours()}`.padStart(2, "0")
  const minute = `${date.getMinutes()}`.padStart(2, "0")
  return `${month}-${day} ${hour}:${minute}`
}

function readinessColor(item: MotryxReadinessItem) {
  if (item.tone === "ok") return motryx.logoGreen
  if (item.tone === "warn") return motryx.redDark
  return motryx.muted
}

function SidecardButton(props: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.selected ? motryx.red : undefined}
      border={["bottom"]}
      borderColor={props.selected ? motryx.red : motryx.line}
      onMouseDown={props.onSelect}
    >
      <text fg={props.selected ? motryx.shellText : motryx.muted} wrapMode="none">{props.label}</text>
    </box>
  )
}

function CockpitHeader(props: { summary: string; compact: boolean }) {
  const line = createMemo(() => {
    const prefix = props.compact ? "FLOW" : "FLOW"
    return `${prefix} · ${props.summary}`
  })
  return (
    <box flexShrink={0} flexDirection="column">
      <text fg={motryx.ink} wrapMode="none">
        <b>{clip(line(), props.compact ? 28 : 40)}</b>
      </text>
    </box>
  )
}

function WorkflowReadyState(props: { model: ReturnType<typeof projectIcTui> }) {
  const hasSession = createMemo(() => Boolean(props.model.focusSessionID))
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      gap={1}
    >
      <box flexDirection="column" border={["left"]} borderColor={motryx.gold} paddingLeft={1}>
        <text fg={motryx.ink} wrapMode="none">
          <b>No workflow yet</b>
        </text>
        <text fg={motryx.muted} wrapMode="word">
          Motryx will show lanes here when the orchestrator starts a workflow.
        </text>
      </box>
      <box flexDirection="column" border={["left"]} borderColor={hasSession() ? motryx.logoGreen : motryx.red} paddingLeft={1}>
        <text fg={hasSession() ? motryx.logoGreen : motryx.redDark} wrapMode="none">
          {hasSession() ? "Orchestrator ready" : "No orchestrator session"}
        </text>
        <text fg={motryx.muted} wrapMode="word">
          {hasSession()
            ? "Continue the conversation on the left."
            : "Start the orchestrator on the left to begin."}
        </text>
      </box>
    </box>
  )
}

function cockpitSummary(model: ReturnType<typeof projectIcTui>) {
  const counts = model.cockpit.counts
  const blocked = model.laneBoard.summary.blocked > 0 ? ` · ${model.laneBoard.summary.blocked} blocked` : ""
  return `${counts.lanes} lanes${blocked}`
}

function AttentionLaneHint(props: { lane?: IcLaneSummary; onSelect: (lane: IcLaneSummary) => void }) {
  return (
    <Show when={props.lane}>
      {(lane) => (
        <box
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={motryx.panelAlt}
          border={["left"]}
          borderColor={laneNeedsAttention(lane()) ? motryx.red : motryx.gold}
          onMouseDown={() => props.onSelect(lane())}
        >
          <text fg={laneNeedsAttention(lane()) ? motryx.redDark : motryx.muted} wrapMode="none">
            {laneBlockedForRoute(lane())
              ? `Blocked: ${clip(lane().name, 22)}`
              : `Next: ${clip(lane().status.toLowerCase(), 8)} ${clip(lane().name, 18)}`}
          </text>
          <Show when={lane().pendingCheckSummary}>
            <text fg={motryx.muted} wrapMode="none">
              {clip(lane().pendingCheckSummary || "", 34)}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

function LaneBoard(props: {
  rows: IcLaneBoardRow[]
  lanes: IcLaneSummary[]
  compact: boolean
  gap: 0 | 1
  showScrollHint: boolean
  onSelectLane: (laneID: string) => void
}) {
  const lanes = createMemo(() => new Map(props.lanes.map((lane) => [lane.id, lane])))
  return (
    <box flexDirection="column" gap={props.gap}>
      <For each={props.rows}>
        {(row) => (
          <LaneBoardRow
            row={row}
            lane={lanes().get(row.laneID)}
            compact={props.compact}
            onSelectLane={() => props.onSelectLane(row.laneID)}
          />
        )}
      </For>
      <Show when={props.showScrollHint}>
        <text fg={motryx.muted} wrapMode="none">
          {props.compact ? "scroll for more" : "scroll for more lanes"}
        </text>
      </Show>
    </box>
  )
}

function LaneBoardRow(props: {
  row: IcLaneBoardRow
  lane?: IcLaneSummary
  compact: boolean
  onSelectLane: () => void
}) {
  const left = createMemo(() => `${pad2(props.row.ordinal)} ${clip(props.row.label, props.compact ? 17 : 25)}`)
  const status = createMemo(() => clipStatus(props.row.statusLabel))
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.row.selected ? motryx.panelAlt : undefined}
      border={["left"]}
      borderColor={props.row.selected ? motryx.red : motryx.panel}
      onMouseDown={props.onSelectLane}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.row.selected ? motryx.ink : motryx.ink} wrapMode="none">{left()}</text>
        <box paddingLeft={1} paddingRight={1} backgroundColor={laneStatusBackground(props.row)}>
          <text fg={laneStatusForeground(props.row)} wrapMode="none">{props.row.attention ? `${status()} !` : status()}</text>
        </box>
      </box>
      <Show when={props.row.selected && props.lane}>
        {(lane) => (
          <box flexDirection="column">
            <text fg={motryx.muted} wrapMode="none">
              {clip(laneBoardDetailLine(props.row, lane()), props.compact ? 28 : 42)}
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}

function laneBoardToneColor(row: IcLaneBoardRow, palette: MotryxPalette) {
  if (row.tone === "blocked") return palette.redDark
  if (row.tone === "checking") return palette.gold
  if (row.tone === "active") return palette.red
  if (row.tone === "done") return palette.green
  return palette.muted
}

function laneStatusBackground(row: IcLaneBoardRow) {
  if (row.tone === "open") return motryx.panelAlt
  return laneBoardToneColor(row, motryx)
}

function laneStatusForeground(row: IcLaneBoardRow) {
  if (row.tone === "open" || row.tone === "checking") return motryx.ink
  return motryx.shellText
}

function clipStatus(status: string) {
  const value = status.toLowerCase().replace(/_/g, "-")
  if (value.includes("block") || value.includes("fail")) return "blocked"
  if (value.includes("work") || value.includes("active") || value.includes("progress")) return "active"
  if (value.includes("check") || value.includes("review")) return "check"
  if (value.includes("done") || value.includes("pass") || value.includes("complete")) return "done"
  if (value.includes("open")) return "open"
  return clip(value, 7)
}

function statusTextColor(status: string) {
  return laneBoardToneColor({ tone: statusTone(status) } as IcLaneBoardRow, motryx)
}

function statusTone(status: string): IcLaneBoardRow["tone"] {
  const value = status.toLowerCase()
  if (/block|fail|error/.test(value)) return "blocked"
  if (/check|review/.test(value)) return "checking"
  if (/work|active|progress/.test(value)) return "active"
  if (/done|pass|complete/.test(value)) return "done"
  return "open"
}

function laneBoardDetailLine(row: IcLaneBoardRow, lane: IcLaneSummary) {
  const dep = row.needs.length ? `dep:${row.needs.join("/")}` : "dep:-"
  const reopen = `reopen:${lane.reopenCount ?? 0}`
  const last = `last:${formatLaneBoardTime(lane.updatedAt)}`
  return `${dep} · ${reopen} · ${last}`
}

function LaneMetricLines(props: { row: IcLaneBoardRow; lane: IcLaneSummary; compact: boolean }) {
  const dep = () => props.row.needs.length ? `dep:${props.row.needs.join("/")}` : "dep:-"
  const reopen = () => `reopen:${props.lane.reopenCount ?? 0}`
  const last = () => `last:${formatLaneBoardTime(props.lane.updatedAt)}`
  return (
    <Show
      when={!props.compact}
      fallback={
        <box flexDirection="column">
          <text fg={motryx.muted} wrapMode="none">{`${dep()} · ${reopen()}`}</text>
          <text fg={motryx.muted} wrapMode="none">{last()}</text>
        </box>
      }
    >
      <text fg={motryx.muted} wrapMode="none">{`${dep()} · ${reopen()} · ${last()}`}</text>
    </Show>
  )
}

function rowFromLane(lane: IcLaneSummary, index: number): IcLaneBoardRow {
  return {
    laneID: lane.id,
    ordinal: index + 1,
    label: lane.name || lane.id,
    statusLabel: lane.status,
    tone: laneNeedsAttention(lane) ? "active" : "open",
    depth: 0,
    branch: "root",
    needs: [],
    selected: lane.selected,
  }
}

function formatLaneBoardTime(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return clip(value, 16)
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  const hour = `${date.getHours()}`.padStart(2, "0")
  const minute = `${date.getMinutes()}`.padStart(2, "0")
  return `${month}-${day} ${hour}:${minute}`
}

function LaneDetail(props: {
  lane?: IcLaneSummary
  index: number
  total: number
  compact: boolean
  rows: IcLaneBoardRow[]
  artifacts: IcArtifactSummary[]
}) {
  const row = createMemo(() => {
    const lane = props.lane
    if (!lane) return
    return props.rows.find((item) => item.laneID === lane.id) ?? rowFromLane(lane, props.index)
  })
  const outputs = createMemo(() => {
    const lane = props.lane
    if (!lane) return []
    return laneArtifacts(props.artifacts, lane).slice(0, 3)
  })
  return (
    <Show when={props.lane}>
      {(lane) => (
        <box flexDirection="column" gap={1}>
          <box
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={motryx.panelAlt}
            border={["left"]}
            borderColor={motryx.red}
          >
            <box flexDirection="row" justifyContent="space-between">
              <text fg={motryx.ink} wrapMode="none">
                {`${pad2(props.index + 1)}/${pad2(props.total)} ${clip(lane().name, props.compact ? 12 : 26)}`}
              </text>
              <text fg={statusTextColor(lane().status)} wrapMode="none">{clipStatus(lane().status)}</text>
            </box>
            <LaneMetricLines row={row() ?? rowFromLane(lane(), props.index)} lane={lane()} compact={props.compact} />
          </box>
          <box flexDirection="column" paddingLeft={1} paddingRight={1} backgroundColor={motryx.panelAlt}>
            <text fg={motryx.ink} wrapMode="none">Current state</text>
            <Show
              when={lane().pendingCheckSummary}
              fallback={
                <text fg={motryx.muted} wrapMode="none">
                  {clip(laneDetailFallback(lane()), props.compact ? 26 : 42)}
                </text>
              }
            >
              {(summary) => <text fg={motryx.redDark} wrapMode="none">{clip(summary(), props.compact ? 30 : 42)}</text>}
            </Show>
          </box>
          <Show when={outputs().length > 0}>
            <box flexDirection="column" gap={1}>
              <text fg={motryx.muted} wrapMode="none">Outputs</text>
              <For each={outputs()}>
                {(artifact) => <ArtifactOutputRow item={artifact} compact={props.compact} />}
              </For>
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}

function laneDetailFallback(lane: IcLaneSummary) {
  if (laneNeedsAttention(lane)) return "Waiting for workflow progress."
  if (clipStatus(lane.status) === "done") return "Completed."
  return "No blocker reported."
}

function laneNeedsAttention(lane: IcLaneSummary) {
  const status = lane.status.toLowerCase()
  const result = lane.lastCheckResult?.toLowerCase() ?? ""
  return /block|check|rework|fail|open|work/.test(status)
    || Boolean(lane.pendingCheckSummary)
    || Boolean(result && !["pass", "passed", "done", "ok", "clean"].includes(result))
}

function laneBlockedForRoute(lane: IcLaneSummary) {
  const status = lane.status.toLowerCase()
  const result = lane.lastCheckResult?.toLowerCase() ?? ""
  return /block|fail|rework|error|dead/.test(status)
    || Boolean(result && !["pass", "passed", "done", "ok", "clean"].includes(result))
}

function pad2(value: number) {
  return value.toString().padStart(2, "0")
}

function laneArtifacts(artifacts: IcArtifactSummary[], lane: IcLaneSummary) {
  const needles = [lane.id, lane.name].map((item) => item.toLowerCase()).filter(Boolean)
  const related = artifacts.filter((item) => {
    const haystack = `${item.id} ${item.title} ${item.path} ${item.detail}`.toLowerCase()
    return needles.some((needle) => haystack.includes(needle))
  })
  return related.length > 0 ? related : artifacts.slice(0, 2)
}

function ArtifactOutputRow(props: { item: IcArtifactSummary; compact: boolean }) {
  const color = () => {
    if (props.item.kind === "doc") return motryx.gold
    if (props.item.kind === "report") return motryx.green
    if (props.item.kind === "log") return motryx.red
    return motryx.muted
  }
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={motryx.panelAlt}
    >
      <text fg={color()} wrapMode="none">{`${props.item.kind} · ${clip(props.item.title, props.compact ? 24 : 36)}`}</text>
      <text fg={motryx.muted} wrapMode="none">{`updated ${formatArtifactTime(props.item.mtime)}`}</text>
    </box>
  )
}

function formatArtifactTime(value: number) {
  if (!value) return "-"
  return formatLaneBoardTime(new Date(value).toISOString())
}

function shouldRefreshFromWorkflowEvent(event: string) {
  return event === "snapshot"
    || event === "heartbeat"
    || event.startsWith("workflow.")
    || event.startsWith("lane.")
    || event.startsWith("diagnostic.")
}

function clip(value: string, length: number) {
  if (value.length <= length) return value
  if (length <= 3) return value.slice(0, length)
  return `${value.slice(0, length - 3)}...`
}
