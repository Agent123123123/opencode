/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import path from "node:path"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { registerOpencodeSpinner } from "../../component/register-spinner"
import { SPINNER_FRAMES } from "../../component/spinner"
import { SessionSurface, type SessionSurfaceProps } from "../../routes/session"
import {
  dismissMotryxIncident,
  fetchMotryxSessions,
  motryxControlConfigFromEnv,
  switchMotryxSession,
  type MotryxControlConfig,
  type MotryxControlSnapshot,
  type MotryxFetcher,
  type MotryxAttentionItemProjection,
  type MotryxLaneProjection,
  type MotryxSessionList,
} from "./control"
import {
  createMotryxProjectionController,
  type MotryxProjectionPhase,
  type MotryxProjectionState,
} from "./projection-events"
import { motryxProductLayout } from "./layout"
import {
  motryxTerminalMarkGlyph,
  motryxTerminalMarkRows,
  type MotryxTerminalMarkCell,
  type MotryxTerminalMarkColor,
  type MotryxTerminalMarkSize,
} from "./terminal-mark"

registerOpencodeSpinner()

export type MotryxConversationRole = "orchestrator" | "coordinator" | "checker"

export type MotryxConversationTarget = {
  role: MotryxConversationRole
  sessionID: string
  laneID?: string
  bindingGeneration?: number
  projectionRevision?: string
}

export type MotryxRouteActions = {
  refresh: () => Promise<void>
  showSessions: () => Promise<void>
  rename: () => Promise<void>
  showFlow: () => void
  showInspect: () => void
  showIncidents: () => void
  dismissLatestIncident: () => void
  focusOrchestrator: () => void
  focusCoordinator: () => void
  focusChecker: () => void
  moveLane: (delta: number) => void
}

type SessionSurfaceComponent = (props: SessionSurfaceProps) => JSX.Element

export function MotryxRoute(props: {
  api: TuiPluginApi
  config?: MotryxControlConfig
  configError?: string
  fetcher?: MotryxFetcher
  debugView?: boolean
  sessionSurface?: SessionSurfaceComponent
  onActionsAvailable: (actions?: MotryxRouteActions) => void
}) {
  const dimensions = useTerminalDimensions()
  const config = props.config
  const Surface = props.sessionSurface ?? SessionSurface
  const [activeConfig, setActiveConfig] = createSignal<MotryxControlConfig | undefined>(config)
  const [snapshot, setSnapshot] = createSignal<MotryxControlSnapshot>()
  const [connection, setConnection] = createSignal<MotryxProjectionState>(
    config ? { phase: "connecting" } : { phase: "unbound", detail: props.configError },
  )
  const [panel, setPanel] = createSignal<"flow" | "inspect" | "incidents">("flow")
  const [selectedLaneID, setSelectedLaneID] = createSignal<string>()
  const [target, setTarget] = createSignal<MotryxConversationTarget | undefined>(
    config ? { role: "orchestrator", sessionID: config.orchestratorSessionID } : undefined,
  )
  const [targetError, setTargetError] = createSignal<string>()
  const [switching, setSwitching] = createSignal(false)
  const [dismissingIncidentID, setDismissingIncidentID] = createSignal<string>()
  const [locallyDismissedAttentionIDs, setLocallyDismissedAttentionIDs] = createSignal<ReadonlySet<string>>(new Set())
  const layout = createMemo(() => motryxProductLayout(dimensions()))
  const selectedLane = createMemo(() => {
    const value = snapshot()
    if (!value) return undefined
    return value.lanes.find((lane) => lane.id === selectedLaneID()) ?? value.lanes[0]
  })
  const targetLaneName = createMemo(() => {
    const laneID = target()?.laneID
    if (!laneID) return undefined
    return snapshot()?.lanes.find((lane) => lane.id === laneID)?.name
  })
  const sidecarWidth = createMemo<number | "100%">(() =>
    layout().direction === "row" ? (layout().sidecarWidth ?? 46) : "100%",
  )
  const sidecarHeight = createMemo(() => layout().sidecarHeight)
  const visibleAttentionItems = createMemo(() => {
    const dismissed = locallyDismissedAttentionIDs()
    return (snapshot()?.attentionItems ?? []).filter((item) =>
      item.kind !== "FINAL_FAILURE" && item.presentationState === "VISIBLE" && !dismissed.has(item.attentionID))
  })
  const conversationWidth = createMemo(() => {
    if (layout().direction === "column") return Math.max(20, dimensions().width - 2)
    return Math.max(20, dimensions().width - (layout().sidecarWidth ?? 46) - 3)
  })
  let targetRead = 0
  let generation: string | undefined
  let projectionController: ReturnType<typeof createMotryxProjectionController> | undefined
  let routeDiscovery: Promise<void> | undefined

  function focusOrchestrator() {
    const current = activeConfig()
    if (!current) return
    targetRead += 1
    setTarget({ role: "orchestrator", sessionID: current.orchestratorSessionID })
    setTargetError(undefined)
  }

  function bindProjection(sessionID: string) {
    if (!config) return
    projectionController?.dispose()
    const nextConfig = { ...config, orchestratorSessionID: sessionID }
    setActiveConfig(nextConfig)
    setSnapshot(undefined)
    setConnection({ phase: "connecting" })
    generation = undefined
    focusOrchestrator()
    const controller = createMotryxProjectionController({
      config: nextConfig,
      fetcher: props.fetcher,
      signal: props.api.lifecycle.signal,
      onSnapshot: setSnapshot,
      onState: setConnection,
      onInvalidated: () => {
        if (!switching()) void discoverCurrentRoute()
      },
    })
    projectionController = controller
    void controller.start()
  }

  async function discoverCurrentRoute(options: { refreshCurrent?: boolean } = {}) {
    if (!config) return
    if (routeDiscovery) return routeDiscovery
    routeDiscovery = (async () => {
      for (let attempt = 0; attempt < 120 && !props.api.lifecycle.signal.aborted; attempt += 1) {
        try {
          const listed = await fetchMotryxSessions(config, {
            fetcher: props.fetcher,
            signal: props.api.lifecycle.signal,
          })
          const sessionID = listed.current?.sessionID
          if (listed.status === "ROUTABLE" && sessionID) {
            if (sessionID !== activeConfig()?.orchestratorSessionID) {
              bindProjection(sessionID)
              props.api.ui.toast({ variant: "info", message: "Motryx Orchestrator route changed." })
            } else if (options.refreshCurrent !== false) {
              await projectionController?.refresh()
            }
            return
          }
          if (listed.status !== "SWITCHING") return
        } catch {
          // A route transition may briefly make the control snapshot unavailable.
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    })().finally(() => {
      routeDiscovery = undefined
    })
    return routeDiscovery
  }

  async function showSessions() {
    if (!config || switching()) return
    try {
      const listed = await fetchMotryxSessions(config, {
        fetcher: props.fetcher,
        signal: props.api.lifecycle.signal,
      })
      showSessionDialog(listed)
    } catch (error) {
      showTargetError(error instanceof Error ? error.message : String(error))
    }
  }

  async function renameOrchestrator() {
    const current = activeConfig()
    const proof = snapshot()
    if (
      !current ||
      connection().phase !== "live" ||
      !proof ||
      proof.orchestratorSessionID !== current.orchestratorSessionID ||
      path.resolve(proof.projectID) !== path.resolve(current.projectID)
    ) {
      showTargetError("Motryx Orchestrator is not currently routable. Retry /rename when the route is live.")
      return
    }
    try {
      const response = await props.api.client.v2.session.get(
        { sessionID: current.orchestratorSessionID },
        { throwOnError: true, signal: props.api.lifecycle.signal },
      )
      const session = response.data.data
      if (
        session.id !== current.orchestratorSessionID ||
        session.agent !== "orchestrator" ||
        path.resolve(session.location.directory) !== path.resolve(current.projectID)
      ) {
        throw new Error("OpenCode did not return the exact current Motryx Orchestrator session")
      }
      props.api.ui.dialog.replace(() => (
        <MotryxRenameDialog
          api={props.api}
          sessionID={session.id}
          title={session.title}
          currentSessionID={() => activeConfig()?.orchestratorSessionID}
        />
      ))
    } catch (error) {
      if (props.api.lifecycle.signal.aborted) return
      showTargetError(error instanceof Error ? error.message : String(error))
    }
  }

  function showSessionDialog(listed: MotryxSessionList) {
    const DialogSelect = props.api.ui.DialogSelect
    props.api.ui.dialog.replace(() => (
      <DialogSelect
        title="Motryx Orchestrators"
        options={listed.sessions.map((item) => ({
          title: item.title,
          value: item.sessionID,
          description: item.state === "CURRENT"
            ? "Current Orchestrator"
            : item.state === "RESUMABLE"
              ? `Resume ${shortSessionID(item.sessionID)}`
              : `Unavailable: ${item.unavailableReason ?? "not resumable"}`,
          category: "Motryx",
          disabled: item.state === "UNAVAILABLE",
        }))}
        current={listed.current?.sessionID}
        onSelect={(option) => {
          props.api.ui.dialog.clear()
          void selectOrchestrator(listed, option.value)
        }}
      />
    ))
  }

  async function selectOrchestrator(listed: MotryxSessionList, sessionID: string) {
    if (!config) return
    if (listed.current?.sessionID === sessionID) {
      focusOrchestrator()
      return
    }
    const selected = listed.sessions.find((item) => item.sessionID === sessionID)
    if (!selected || selected.state !== "RESUMABLE" || !listed.current) {
      showTargetError("Selected Motryx Orchestrator is not resumable.")
      return
    }
    const proof = snapshot()
    if (
      connection().phase !== "live" ||
      !proof ||
      proof.orchestratorSessionID !== listed.current.sessionID ||
      proof.route.serverGeneration !== listed.current.serverGeneration ||
      proof.binding.bindingGeneration !== listed.current.bindingGeneration ||
      proof.binding.ownerRunID !== listed.current.ownerRunID
    ) {
      showTargetError("Motryx route changed while the session picker was open. Reopen /sessions.")
      void discoverCurrentRoute()
      return
    }
    setSwitching(true)
    setConnection({ phase: "starting", detail: `Switching to ${selected.title}` })
    try {
      const result = await switchMotryxSession(config, {
        targetSessionID: sessionID,
        expected: listed.current,
      }, {
        fetcher: props.fetcher,
        signal: props.api.lifecycle.signal,
      })
      const current = result.current
      if (!current) throw new Error("Motryx switch returned no current route")
      const response = await props.api.client.v2.session.get({ sessionID: current.sessionID }, { throwOnError: true })
      if (
        response.data.data.id !== current.sessionID ||
        response.data.data.agent !== "orchestrator" ||
        path.resolve(response.data.data.location.directory) !== path.resolve(config.projectID)
      ) {
        throw new Error("OpenCode did not return the exact switched Orchestrator session")
      }
      bindProjection(current.sessionID)
      props.api.ui.toast({ variant: "success", message: `Switched to ${selected.title}` })
    } catch (error) {
      showTargetError(error instanceof Error ? error.message : String(error))
      await discoverCurrentRoute()
    } finally {
      setSwitching(false)
    }
  }

  async function focusWorker(role: "coordinator" | "checker", laneID?: string) {
    if (!props.debugView) return
    const value = snapshot()
    const lane = laneID ? value?.lanes.find((item) => item.id === laneID) : selectedLane()
    if (!value || connection().phase !== "live" || !lane) {
      showTargetError(`${capitalize(role)} session is unavailable without a live selected lane.`)
      return
    }
    const projected = resolveProjectedDebugTarget(value, lane.id, role)
    if (!projected) {
      showTargetError(`Lane ${lane.name} has no exact active ${role} session.`)
      return
    }
    const read = ++targetRead
    const revision = value.projectionRevision
    try {
      const response = await props.api.client.v2.session.get({ sessionID: projected.sessionID }, { throwOnError: true })
      const exact = response.data.data
      if (exact.id !== projected.sessionID) throw new Error(`OpenCode returned unexpected session ${exact.id}`)
      if (path.resolve(exact.location.directory) !== value.projectID) {
        throw new Error("OpenCode session belongs to a different project")
      }
      if (exact.agent !== role) throw new Error(`OpenCode session agent is ${exact.agent}, expected ${role}`)
      const current = snapshot()
      if (
        read !== targetRead ||
        !current ||
        connection().phase !== "live" ||
        current.projectionRevision !== revision ||
        !resolveProjectedDebugTarget(current, lane.id, role)
      ) {
        throw new Error("Motryx projection changed while validating the debug target")
      }
      setSelectedLaneID(lane.id)
      setTarget(projected)
      setTargetError(undefined)
    } catch (error) {
      if (read !== targetRead) return
      showTargetError(error instanceof Error ? error.message : String(error))
    }
  }

  function selectWorkerRole(role: "coordinator" | "checker") {
    if (!props.debugView) return
    void focusWorker(role)
  }

  function showTargetError(message: string) {
    setTargetError(message)
    props.api.ui.toast({ variant: "warning", message })
  }

  function dismissAttentionLocally(attentionID: string) {
    setLocallyDismissedAttentionIDs((current) => new Set([...current, attentionID]))
  }

  async function dismissIncident(incidentID: string) {
    const current = activeConfig()
    const proof = snapshot()
    if (!current || !proof || connection().phase !== "live" || dismissingIncidentID()) return
    setDismissingIncidentID(incidentID)
    setSnapshot({
      ...proof,
      incidents: proof.incidents.map((incident) => incident.incidentID === incidentID
        ? { ...incident, presentationState: "DISMISSED" as const }
        : incident),
      attention: {
        ...proof.attention,
        visibleOpenIncidentCount: Math.max(0, proof.attention.visibleOpenIncidentCount - 1),
      },
    })
    try {
      await dismissMotryxIncident(current, { incidentID, snapshot: proof }, {
        fetcher: props.fetcher,
        signal: props.api.lifecycle.signal,
      })
      await projectionController?.refresh()
    } catch (error) {
      setSnapshot(proof)
      showTargetError(error instanceof Error ? error.message : String(error))
    } finally {
      setDismissingIncidentID(undefined)
    }
  }

  function selectLane(lane: MotryxLaneProjection) {
    setSelectedLaneID(lane.id)
    setPanel("inspect")
  }

  function moveLane(delta: number) {
    const lanes = snapshot()?.lanes ?? []
    if (lanes.length === 0) return
    const current = Math.max(
      0,
      lanes.findIndex((lane) => lane.id === selectedLane()?.id),
    )
    selectLane(lanes[(current + delta + lanes.length) % lanes.length])
  }

  createEffect(() => {
    const value = snapshot()
    if (!value) return
    const available = new Set(value.attentionItems.map((item) => item.attentionID))
    setLocallyDismissedAttentionIDs((current) => {
      const retained = new Set([...current].filter((attentionID) => available.has(attentionID)))
      return retained.size === current.size ? current : retained
    })
    const selected = selectedLaneID()
    if (!selected || !value.lanes.some((lane) => lane.id === selected)) {
      setSelectedLaneID(value.lanes[0]?.id)
      if (selected)
        props.api.ui.toast({ variant: "info", message: "Selected lane disappeared; moved to the first lane." })
    }
    const proofGeneration = `${value.route.serverGeneration}:${value.binding.bindingGeneration}`
    if (generation === undefined) generation = proofGeneration
    else if (generation !== proofGeneration) {
      generation = proofGeneration
      focusOrchestrator()
      props.api.ui.toast({ variant: "info", message: "Binding generation changed; showing Orchestrator." })
    }
    const current = target()
    if (!current || current.role === "orchestrator") return
    if (!props.debugView || connection().phase !== "live" || !current.laneID) {
      focusOrchestrator()
      return
    }
    const projected = resolveProjectedDebugTarget(value, current.laneID, current.role)
    if (!projected || projected.sessionID !== current.sessionID) focusOrchestrator()
  })

  createEffect(() => {
    if (connection().phase === "live") return
    if (target()?.role !== "orchestrator") focusOrchestrator()
  })

  onMount(() => {
    if (!config) return
    const actions: MotryxRouteActions = {
      refresh: async () => projectionController?.refresh().then(() => undefined),
      showSessions,
      rename: renameOrchestrator,
      showFlow: () => setPanel("flow"),
      showInspect: () => setPanel("inspect"),
      showIncidents: () => setPanel("incidents"),
      dismissLatestIncident: () => {
        const latest = snapshot()?.incidents.find((incident) =>
          incident.status === "OPEN" && incident.presentationState === "VISIBLE")
        if (latest) void dismissIncident(latest.incidentID)
      },
      focusOrchestrator,
      focusCoordinator: () => selectWorkerRole("coordinator"),
      focusChecker: () => selectWorkerRole("checker"),
      moveLane,
    }
    props.onActionsAvailable(actions)
    bindProjection(config.orchestratorSessionID)
    void discoverCurrentRoute({ refreshCurrent: false })
    onCleanup(() => {
      targetRead += 1
      props.onActionsAvailable(undefined)
      projectionController?.dispose()
    })
  })

  const status = createMemo(() => statusPresentation(connection().phase))
  const initialLoading = createMemo(
    () => switching() || (!snapshot() && (connection().phase === "connecting" || connection().phase === "starting")),
  )

  return (
    <box
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
    >
      <MotryxHeader
        api={props.api}
        width={dimensions().width}
        snapshot={snapshot()}
        target={target()}
        laneName={targetLaneName()}
        debugView={props.debugView === true}
        phase={connection().phase}
        status={status()}
        visibleAttentionCount={visibleAttentionItems().length}
      />

      <Show
        when={!initialLoading()}
        fallback={
          <MotryxLoadingPage
            api={props.api}
            width={dimensions().width}
            height={dimensions().height - 1}
            phase={connection().phase}
          />
        }
      >
        <box
          flexGrow={1}
          minHeight={0}
          flexDirection={layout().direction}
          gap={layout().collapsedSidecar ? 0 : 1}
          paddingLeft={layout().collapsedSidecar ? 0 : 1}
          paddingRight={layout().collapsedSidecar ? 0 : 1}
          paddingBottom={layout().collapsedSidecar ? 0 : 1}
        >
          <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
            <ConversationTargetBar
              api={props.api}
              debugView={props.debugView === true}
              target={target()}
              laneName={targetLaneName()}
              error={targetError()}
              compact={conversationWidth() < 84}
              onOrchestrator={focusOrchestrator}
            />
            <RuntimeIncidentCard
              api={props.api}
              incidents={(snapshot()?.incidents ?? []).filter((incident) =>
                incident.status === "OPEN" && incident.presentationState === "VISIBLE")}
              busyIncidentID={dismissingIncidentID()}
              onDismiss={(incidentID) => void dismissIncident(incidentID)}
            />
            <RuntimeAttentionBanner
              api={props.api}
              items={visibleAttentionItems()}
              onDismiss={dismissAttentionLocally}
            />
            <Show
              when={target()}
              fallback={
                <text fg={props.api.theme.current.error}>{props.configError ?? "Motryx session is unbound"}</text>
              }
            >
              {(value) => (
                <Surface
                  sessionID={value().sessionID}
                  width={conversationWidth()}
                  showNativeSidebar={false}
                  showIdleFooter={false}
                  showExitEpilogue={false}
                  interaction={value().role === "orchestrator" ? "interactive" : "read-only"}
                  historyMutation="disabled"
                  onSessionUnavailable={(error) => {
                    showTargetError(error instanceof Error ? error.message : String(error))
                    if (value().role !== "orchestrator" && target()?.sessionID === value().sessionID)
                      focusOrchestrator()
                  }}
                />
              )}
            </Show>
          </box>

          <Show when={layout().showSidecar}>
            <SidecarPanel
              api={props.api}
              snapshot={snapshot()}
              state={connection()}
              selectedLane={selectedLane()}
              panel={panel()}
              debugView={props.debugView === true}
              width={sidecarWidth()}
              height={sidecarHeight()}
              collapsed={layout().collapsedSidecar}
              onPanel={setPanel}
              onLane={selectLane}
              onConversation={(role, laneID) => void focusWorker(role, laneID)}
              onDismissIncident={(incidentID) => void dismissIncident(incidentID)}
              locallyDismissedAttentionIDs={locallyDismissedAttentionIDs()}
              onDismissAttention={dismissAttentionLocally}
            />
          </Show>
        </box>
      </Show>
    </box>
  )
}

function MotryxRenameDialog(props: {
  api: TuiPluginApi
  sessionID: string
  title: string
  currentSessionID: () => string | undefined
}) {
  const [busy, setBusy] = createSignal(false)
  return (
    <props.api.ui.DialogPrompt
      title="Rename Motryx Orchestrator"
      value={props.title}
      busy={busy()}
      busyText="Renaming Orchestrator..."
      onConfirm={(raw) => {
        if (busy() || props.api.lifecycle.signal.aborted) return
        const title = raw.trim()
        if (!title) {
          props.api.ui.toast({ variant: "error", message: "Session name is required." })
          return
        }
        if (title.length > 100) {
          props.api.ui.toast({ variant: "error", message: "Session name must be 100 characters or fewer." })
          return
        }
        if (props.currentSessionID() !== props.sessionID) {
          props.api.ui.dialog.clear()
          props.api.ui.toast({
            variant: "warning",
            message: "Motryx route changed while rename was open. Run /rename again for the current Orchestrator.",
          })
          return
        }
        if (title === props.title) {
          props.api.ui.dialog.clear()
          props.api.ui.toast({ variant: "info", message: "Motryx Orchestrator name is unchanged." })
          return
        }
        setBusy(true)
        void (async () => {
          try {
            const response = await props.api.client.v2.session.update(
              { sessionID: props.sessionID, title },
              { throwOnError: true, signal: props.api.lifecycle.signal },
            )
            if (response.data.data.id !== props.sessionID || response.data.data.title !== title) {
              throw new Error("OpenCode returned an unexpected Session rename result")
            }
          } catch (error) {
            if (props.api.lifecycle.signal.aborted) return
            try {
              const readback = await props.api.client.v2.session.get(
                { sessionID: props.sessionID },
                { throwOnError: true, signal: props.api.lifecycle.signal },
              )
              if (readback.data.data.id === props.sessionID && readback.data.data.title === title) {
                props.api.ui.dialog.clear()
                props.api.ui.toast({ variant: "success", message: `Renamed Motryx Orchestrator to ${title}` })
                return
              }
            } catch {
              // The original mutation error remains the actionable failure.
            }
            if (props.api.lifecycle.signal.aborted) return
            setBusy(false)
            props.api.ui.toast({
              variant: "error",
              message: error instanceof Error ? error.message : "Failed to rename Motryx Orchestrator",
            })
            return
          }
          if (props.api.lifecycle.signal.aborted) return
          props.api.ui.dialog.clear()
          props.api.ui.toast({ variant: "success", message: `Renamed Motryx Orchestrator to ${title}` })
        })()
      }}
      onCancel={() => props.api.ui.dialog.clear()}
    />
  )
}

function MotryxHeader(props: {
  api: TuiPluginApi
  width: number
  snapshot?: MotryxControlSnapshot
  target?: MotryxConversationTarget
  laneName?: string
  debugView: boolean
  phase: MotryxProjectionPhase
  status?: string
  visibleAttentionCount: number
}) {
  const target = createMemo(() => {
    if (!props.target) return "No active conversation"
    const role = props.target.role
    if (role === "orchestrator") return "Orchestrator"
    return `${props.laneName ?? "Selected lane"} / ${capitalize(role)}`
  })
  const context = createMemo(() => {
    const goal = props.snapshot?.workflow?.goal.trim()
    if (props.width >= 120 && goal && goal !== props.laneName) return `${goal} / ${target()}`
    return target()
  })
  const debugLabel = createMemo(() => (props.width < 64 ? "DBG" : "DEBUG"))

  return (
    <box
      flexShrink={0}
      height={1}
      minWidth={0}
      flexDirection="row"
      gap={1}
      paddingLeft={1}
      paddingRight={2}
      backgroundColor={props.api.theme.current.backgroundPanel}
    >
      <box flexShrink={0} flexDirection="row">
        <text fg={props.api.theme.current.text}>Motry</text>
        <text fg={props.api.theme.current.primary}>X</text>
      </box>
      <text fg={props.api.theme.current.border}>│</text>
      <text flexGrow={1} minWidth={0} fg={props.api.theme.current.textMuted} truncate>
        {context()}
      </text>
      <Show when={props.debugView && (!props.status || props.width >= 72)}>
        <text fg={props.api.theme.current.warning}>{debugLabel()}</text>
      </Show>
      <Show when={props.status}>
        {(label) => <text fg={statusColor(props.api, props.phase)}>{label()}</text>}
      </Show>
      <Show when={(props.snapshot?.attention.visibleOpenIncidentCount ?? 0) + props.visibleAttentionCount > 0}>
        <text fg={props.api.theme.current.error}>
          ! {(props.snapshot?.attention.visibleOpenIncidentCount ?? 0) + props.visibleAttentionCount}
        </text>
      </Show>
    </box>
  )
}

function RuntimeIncidentCard(props: {
  api: TuiPluginApi
  incidents: MotryxControlSnapshot["incidents"]
  busyIncidentID?: string
  onDismiss: (incidentID: string) => void
}) {
  const latest = createMemo(() => props.incidents[0])
  return (
    <Show when={latest()}>
      {(incident) => (
        <box
          flexShrink={0}
          minHeight={3}
          flexDirection="column"
          border={["top", "bottom", "left", "right"]}
          borderColor={props.api.theme.current.error}
          paddingLeft={1}
          paddingRight={1}
        >
          <box flexDirection="row" gap={1}>
            <text fg={props.api.theme.current.error}>Runtime error · {capitalize(incident().role)}</text>
            <box flexGrow={1} />
            <Show when={props.incidents.length > 1}>
              <text fg={props.api.theme.current.textMuted}>{props.incidents.length - 1} more</text>
            </Show>
            <box
              onMouseUp={() => props.onDismiss(incident().incidentID)}
              backgroundColor={props.api.theme.current.backgroundElement}
            >
              <text fg={props.api.theme.current.primary}>
                {props.busyIncidentID === incident().incidentID ? " … " : " [×] "}
              </text>
            </box>
          </box>
          <text fg={props.api.theme.current.text} wrapMode="word">
            {incident().safeSummary}
          </text>
          <Show when={runtimeIncidentDiagnostic(incident())}>
            {(detail) => <text fg={props.api.theme.current.textMuted}>{detail()}</text>}
          </Show>
        </box>
      )}
    </Show>
  )
}

function RuntimeAttentionBanner(props: {
  api: TuiPluginApi
  items: MotryxAttentionItemProjection[]
  onDismiss: (attentionID: string) => void
}) {
  const ordered = createMemo(() => [...props.items].sort(compareRuntimeAttention))
  const current = createMemo(() => ordered()[0])
  return (
    <Show when={current()}>
      {(attention) => (
        <box
          flexShrink={0}
          minHeight={3}
          flexDirection="column"
          border={["top", "bottom", "left", "right"]}
          borderColor={runtimeAttentionColor(props.api, attention().severity)}
          paddingLeft={1}
          paddingRight={1}
        >
          <box flexDirection="row" gap={1}>
            <text fg={runtimeAttentionColor(props.api, attention().severity)}>
              {runtimeAttentionTitle(attention())} · {capitalize(attention().role)}
            </text>
            <box flexGrow={1} />
            <Show when={ordered().length > 1}>
              <text fg={props.api.theme.current.textMuted}>{ordered().length - 1} more</text>
            </Show>
            <box
              onMouseUp={attention().dismissible ? () => props.onDismiss(attention().attentionID) : undefined}
              backgroundColor={props.api.theme.current.backgroundElement}
            >
              <text fg={attention().dismissible ? props.api.theme.current.primary : props.api.theme.current.textMuted}>
                {attention().dismissible ? " [×] " : ""}
              </text>
            </box>
          </box>
          <text fg={props.api.theme.current.text} wrapMode="word">{attention().summary}</text>
          <Show when={runtimeAttentionDiagnostic(attention())}>
            {(detail) => <text fg={props.api.theme.current.textMuted}>{detail()}</text>}
          </Show>
        </box>
      )}
    </Show>
  )
}

function MotryxLoadingPage(props: {
  api: TuiPluginApi
  width: number
  height: number
  phase: MotryxProjectionPhase
}) {
  const compact = createMemo(() => props.width < 54 || props.height < 17)
  const showMark = createMemo(() => props.width >= 28 && props.height >= 11)
  const message = createMemo(() =>
    props.phase === "starting" ? "Reconciling workflow…" : "Connecting conversation and workflow…",
  )
  return (
    <box flexGrow={1} minHeight={0} justifyContent="center" alignItems="center" flexDirection="column" gap={1}>
      <Show when={showMark()}>
        <MotryxLoadingMark api={props.api} size={compact() ? "compact" : "standard"} />
      </Show>
      <box flexDirection="row">
        <text fg={props.api.theme.current.text}>Motry</text>
        <text fg={props.api.theme.current.primary}>X</text>
      </box>
      <box flexDirection="row" gap={1}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={props.api.theme.current.primary} />
        <text fg={props.api.theme.current.textMuted}>{message()}</text>
      </box>
    </box>
  )
}

function MotryxLoadingMark(props: { api: TuiPluginApi; size: MotryxTerminalMarkSize }) {
  const rows = createMemo(() => motryxTerminalMarkRows(props.size))
  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => (
          <text>
            <For each={row}>{(cell) => <MotryxLoadingMarkCell api={props.api} cell={cell} />}</For>
          </text>
        )}
      </For>
    </box>
  )
}

function MotryxLoadingMarkCell(props: { api: TuiPluginApi; cell: MotryxTerminalMarkCell }) {
  const glyph = motryxTerminalMarkGlyph(props.cell)
  const top = motryxLoadingMarkColor(props.api, props.cell.top)
  const bottom = motryxLoadingMarkColor(props.api, props.cell.bottom)
  if (!top && !bottom) return <span> </span>
  if (!top || !bottom || props.cell.top === props.cell.bottom) {
    return <span style={{ fg: top ?? bottom }}>{glyph}</span>
  }
  return <span style={{ fg: top, bg: bottom }}>{glyph}</span>
}

function motryxLoadingMarkColor(api: TuiPluginApi, color: MotryxTerminalMarkColor) {
  if (color === "C") return api.theme.current.text
  if (color === "G") return api.theme.current.primary
}

function ConversationTargetBar(props: {
  api: TuiPluginApi
  debugView: boolean
  target?: MotryxConversationTarget
  laneName?: string
  error?: string
  compact: boolean
  onOrchestrator: () => void
}) {
  const showWorker = () => props.debugView && props.target?.role !== "orchestrator"
  return (
    <Show when={showWorker()}>
      <box flexShrink={0} flexDirection={props.compact ? "column" : "row"} gap={props.compact ? 0 : 1}>
        <box minWidth={0} flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.primary}>{capitalize(props.target?.role ?? "unbound")}</text>
          <Show when={props.laneName}>
            {(laneName) => (
              <text fg={props.api.theme.current.textMuted} truncate>
                · {laneName()}
              </text>
            )}
          </Show>
          <Show when={props.error}>
            {(error) => (
              <text fg={props.api.theme.current.warning} truncate>
                · {error()}
              </text>
            )}
          </Show>
        </box>
        <Show when={!props.compact}>
          <box flexGrow={1} />
        </Show>
        <TargetChoice api={props.api} label="← Back to Orchestrator" onPick={props.onOrchestrator} />
      </box>
    </Show>
  )
}

function TargetChoice(props: { api: TuiPluginApi; label: string; onPick: () => void }) {
  return (
    <box onMouseUp={props.onPick} backgroundColor={props.api.theme.current.backgroundElement}>
      <text fg={props.api.theme.current.primary}> {props.label} </text>
    </box>
  )
}

function SidecarPanel(props: {
  api: TuiPluginApi
  snapshot?: MotryxControlSnapshot
  state: MotryxProjectionState
  selectedLane?: MotryxLaneProjection
  panel: "flow" | "inspect" | "incidents"
  debugView: boolean
  width: number | "100%"
  height: number | "100%"
  collapsed: boolean
  onPanel: (panel: "flow" | "inspect" | "incidents") => void
  onLane: (lane: MotryxLaneProjection) => void
  onConversation: (role: "coordinator" | "checker", laneID: string) => void
  onDismissIncident: (incidentID: string) => void
  locallyDismissedAttentionIDs: ReadonlySet<string>
  onDismissAttention: (attentionID: string) => void
}) {
  return (
    <Show
      when={props.collapsed}
      fallback={
        <box
          width={props.width}
          height={props.height}
          flexShrink={0}
          minHeight={0}
          flexDirection="column"
          border={["top", "bottom", "left", "right"]}
          borderColor={
            props.state.phase === "live" ? props.api.theme.current.borderActive : props.api.theme.current.border
          }
          paddingLeft={1}
          paddingRight={1}
        >
          <SidecarTabs api={props.api} panel={props.panel} state={props.state} onPanel={props.onPanel} />
          <Show
            when={props.snapshot}
            fallback={
              <box paddingTop={1}>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">
                  {props.state.detail ?? "Waiting for the workflow projection."}
                </text>
              </box>
            }
          >
            {(value) => (
              <>
              <Show when={props.panel === "flow"}>
                <FlowPanel
                  api={props.api}
                  snapshot={value()}
                  selectedLaneID={props.selectedLane?.id}
                  onLane={props.onLane}
                />
              </Show>
              <Show when={props.panel === "inspect"}>
                  <InspectPanel
                    api={props.api}
                    snapshot={value()}
                    lane={props.selectedLane}
                    debugView={props.debugView}
                    projectionLive={props.state.phase === "live"}
                    onConversation={props.onConversation}
                  />
              </Show>
              <Show when={props.panel === "incidents"}>
                <IncidentsPanel
                  api={props.api}
                  snapshot={value()}
                  locallyDismissedAttentionIDs={props.locallyDismissedAttentionIDs}
                  onDismissAttention={props.onDismissAttention}
                  onDismiss={props.onDismissIncident}
                />
              </Show>
              </>
            )}
          </Show>
        </box>
      }
    >
      <box
        width={props.width}
        height={props.height}
        flexShrink={0}
        minHeight={0}
        flexDirection="column"
        border={["top"]}
        borderColor={
          props.state.phase === "live" ? props.api.theme.current.borderActive : props.api.theme.current.border
        }
        paddingLeft={1}
        paddingRight={1}
      >
        <box minWidth={0} flexDirection="row" gap={1}>
          <PanelTab api={props.api} label="FLOW" active={props.panel === "flow"} onPick={() => props.onPanel("flow")} />
          <PanelTab
            api={props.api}
            label="INSPECT"
            active={props.panel === "inspect"}
            onPick={() => props.onPanel("inspect")}
          />
          <PanelTab
            api={props.api}
            label="INCIDENTS"
            active={props.panel === "incidents"}
            onPick={() => props.onPanel("incidents")}
          />
          <box minWidth={0} flexGrow={1}>
            <text fg={props.api.theme.current.textMuted} truncate>
              {props.selectedLane
                ? `${props.selectedLane.name} · ${motryxLaneStatusLabel(props.selectedLane.status)}`
                : (props.state.detail ?? "No lane selected")}
            </text>
          </box>
          <Show when={statusPresentation(props.state.phase)}>
            {(label) => <text fg={statusColor(props.api, props.state.phase)}>{label()}</text>}
          </Show>
        </box>
      </box>
    </Show>
  )
}

function SidecarTabs(props: {
  api: TuiPluginApi
  panel: "flow" | "inspect" | "incidents"
  state: MotryxProjectionState
  onPanel: (panel: "flow" | "inspect" | "incidents") => void
}) {
  return (
    <box flexShrink={0} flexDirection="row" gap={1}>
      <PanelTab api={props.api} label="FLOW" active={props.panel === "flow"} onPick={() => props.onPanel("flow")} />
      <PanelTab
        api={props.api}
        label="INSPECT"
        active={props.panel === "inspect"}
        onPick={() => props.onPanel("inspect")}
      />
      <PanelTab
        api={props.api}
        label="INCIDENTS"
        active={props.panel === "incidents"}
        onPick={() => props.onPanel("incidents")}
      />
      <box flexGrow={1} />
      <Show when={statusPresentation(props.state.phase)}>
        {(label) => <text fg={statusColor(props.api, props.state.phase)}>{label()}</text>}
      </Show>
    </box>
  )
}

function PanelTab(props: { api: TuiPluginApi; label: string; active: boolean; onPick: () => void }) {
  return (
    <box onMouseUp={props.onPick}>
      <text fg={props.active ? props.api.theme.current.primary : props.api.theme.current.textMuted}>
        {props.active ? `[${props.label}]` : props.label}
      </text>
    </box>
  )
}

function FlowPanel(props: {
  api: TuiPluginApi
  snapshot: MotryxControlSnapshot
  selectedLaneID?: string
  onLane: (lane: MotryxLaneProjection) => void
}) {
  return (
    <Show
      when={props.snapshot.workflow}
      fallback={
        <box flexDirection="column" paddingTop={1} gap={1}>
          <text fg={props.api.theme.current.text}>No workflow yet.</text>
          <text fg={props.api.theme.current.textMuted} wrapMode="word">
            Continue the Orchestrator conversation; lanes will appear when a workflow starts.
          </text>
        </box>
      }
    >
      {(workflow) => (
        <>
          <box flexShrink={0} maxHeight={4} overflow="hidden">
            <text fg={props.api.theme.current.textMuted} wrapMode="word">
              {workflow().goal}
            </text>
          </box>
          <text fg={props.snapshot.capacity.capacityReached ? props.api.theme.current.warning : props.api.theme.current.textMuted}>
            worker lanes {props.snapshot.capacity.activeCount}/{props.snapshot.capacity.maxConcurrentLanes === 0
              ? "unlimited"
              : props.snapshot.capacity.maxConcurrentLanes}
            {props.snapshot.capacity.readyLaneIDs.length > 0
              ? ` · ready ${props.snapshot.capacity.readyLaneIDs.length}`
              : ""}
          </text>
          <scrollbox
            flexGrow={1}
            minHeight={0}
            verticalScrollbarOptions={{ visible: true }}
            horizontalScrollbarOptions={{ visible: false }}
          >
            <Show
              when={props.snapshot.lanes.length > 0}
              fallback={<text fg={props.api.theme.current.textMuted}>No lanes yet.</text>}
            >
              <For each={props.snapshot.lanes}>
                {(lane, index) => (
                  <LaneRow
                    api={props.api}
                    lane={lane}
                    ordinal={index() + 1}
                    selected={lane.id === props.selectedLaneID}
                    onPick={() => props.onLane(lane)}
                  />
                )}
              </For>
            </Show>
          </scrollbox>
        </>
      )}
    </Show>
  )
}

function LaneRow(props: {
  api: TuiPluginApi
  lane: MotryxLaneProjection
  ordinal: number
  selected: boolean
  onPick: () => void
}) {
  const status = () => (props.lane.schedulingPhase ?? props.lane.status).toUpperCase()
  const attention = () => status() === "BLOCKED" || status() === "FAILED" || props.lane.pendingCheckSummary !== undefined
  return (
    <box
      flexDirection="column"
      paddingBottom={1}
      paddingLeft={props.selected ? 1 : 0}
      backgroundColor={props.selected ? props.api.theme.current.backgroundElement : undefined}
      onMouseUp={props.onPick}
    >
      <box flexDirection="row" gap={1}>
        <text fg={props.selected ? props.api.theme.current.primary : props.api.theme.current.textMuted}>
          {props.selected ? "›" : String(props.ordinal).padStart(2, "0")}
        </text>
        <Show when={attention()}>
          <text fg={props.api.theme.current.warning}>!</text>
        </Show>
        <text fg={props.api.theme.current.text} truncate>
          {props.lane.name}
        </text>
        <box flexGrow={1} />
        <text fg={laneColor(props.api, status())}>{motryxLaneStatusLabel(status())}</text>
      </box>
      <Show when={props.lane.dependsOnLaneIDs.length > 0}>
        <text fg={props.api.theme.current.textMuted}>depends on {props.lane.dependsOnLaneIDs.length}</text>
      </Show>
    </box>
  )
}

function IncidentsPanel(props: {
  api: TuiPluginApi
  snapshot: MotryxControlSnapshot
  locallyDismissedAttentionIDs: ReadonlySet<string>
  onDismissAttention: (attentionID: string) => void
  onDismiss: (incidentID: string) => void
}) {
  const activeAttention = createMemo(() => props.snapshot.attentionItems
    .filter((item) => item.kind !== "FINAL_FAILURE" && item.presentationState === "VISIBLE")
    .sort(compareRuntimeAttention))
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      verticalScrollbarOptions={{ visible: true }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <text fg={props.api.theme.current.text}>Active runtime attention</text>
      <Show when={activeAttention().length > 0} fallback={
        <text fg={props.api.theme.current.textMuted}>No active runtime attention.</text>
      }>
        <For each={activeAttention()}>
          {(attention) => (
            <box flexDirection="column" gap={1} paddingBottom={1}>
              <box flexDirection="row" gap={1}>
                <text fg={runtimeAttentionColor(props.api, attention.severity)}>
                  {attention.severity} · {runtimeAttentionTitle(attention)} · {capitalize(attention.role)}
                </text>
                <box flexGrow={1} />
                <Show when={attention.dismissible}>
                  <Show
                    when={!props.locallyDismissedAttentionIDs.has(attention.attentionID)}
                    fallback={<text fg={props.api.theme.current.textMuted}>hidden locally</text>}
                  >
                    <box onMouseUp={() => props.onDismissAttention(attention.attentionID)}>
                      <text fg={props.api.theme.current.primary}>[×]</text>
                    </box>
                  </Show>
                </Show>
              </box>
              <text fg={props.api.theme.current.text} wrapMode="word">{attention.summary}</text>
              <Show when={runtimeAttentionDiagnostic(attention)}>
                {(detail) => <text fg={props.api.theme.current.textMuted}>{detail()}</text>}
              </Show>
              <text fg={props.api.theme.current.textMuted}>
                {attention.attentionID}{attention.laneID ? ` · lane ${attention.laneID}` : ""}
              </text>
            </box>
          )}
        </For>
      </Show>
      <text fg={props.api.theme.current.text}>Runtime incidents</text>
      <Show
        when={props.snapshot.incidents.length > 0}
        fallback={<text fg={props.api.theme.current.textMuted}>No runtime incidents.</text>}
      >
        <For each={props.snapshot.incidents}>
          {(incident) => (
            <box flexDirection="column" gap={1} paddingBottom={1}>
              <box flexDirection="row" gap={1}>
                <text fg={incident.status === "OPEN" ? props.api.theme.current.error : props.api.theme.current.textMuted}>
                  {incident.status} · {capitalize(incident.role)} · {incident.failureKind}
                </text>
                <box flexGrow={1} />
                <Show when={incident.status === "OPEN" && incident.presentationState === "VISIBLE"}>
                  <box onMouseUp={() => props.onDismiss(incident.incidentID)}>
                    <text fg={props.api.theme.current.primary}>[×]</text>
                  </box>
                </Show>
                <Show when={incident.presentationState === "DISMISSED"}>
                  <text fg={props.api.theme.current.textMuted}>dismissed</text>
                </Show>
              </box>
              <text fg={props.api.theme.current.text} wrapMode="word">{incident.safeSummary}</text>
              <Show when={runtimeIncidentDiagnostic(incident)}>
                {(detail) => <text fg={props.api.theme.current.textMuted}>{detail()}</text>}
              </Show>
              <text fg={props.api.theme.current.textMuted}>
                {incident.incidentID}{incident.laneID ? ` · lane ${incident.laneID}` : ""}
              </text>
            </box>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}

function runtimeIncidentDiagnostic(incident: MotryxControlSnapshot["incidents"][number]): string | undefined {
  const values = [
    incident.httpStatus ? `HTTP ${incident.httpStatus}` : undefined,
    incident.transportCode ? `transport ${incident.transportCode}` : undefined,
    incident.transportKind ? `kind ${incident.transportKind}` : undefined,
    incident.providerID && incident.modelID ? `${incident.providerID}/${incident.modelID}` : undefined,
  ].filter((value): value is string => Boolean(value))
  return values.length > 0 ? values.join(" · ") : undefined
}

function compareRuntimeAttention(left: MotryxAttentionItemProjection, right: MotryxAttentionItemProjection): number {
  const severity = { ERROR: 3, WARNING: 2, INFO: 1 } as const
  return severity[right.severity] - severity[left.severity] ||
    Number(right.actionRequired) - Number(left.actionRequired) ||
    right.createdAt - left.createdAt ||
    left.attentionID.localeCompare(right.attentionID)
}

function runtimeAttentionTitle(attention: MotryxAttentionItemProjection): string {
  const labels: Record<MotryxAttentionItemProjection["kind"], string> = {
    PROVIDER_RETRY: "Provider retry",
    RUN_RETRY_SCHEDULED: "Run retry scheduled",
    RUN_RETRY_RUNNING: "Run retry running",
    PROTOCOL_CORRECTION: "Protocol correction",
    DELIVERY_RETRY: "Input delivery retry",
    OUTCOME_UNKNOWN: "Outcome unknown",
    WAITING_ATTENTION: "Waiting for attention",
    WAITING_RUNTIME_REPAIR: "Waiting for runtime repair",
    WAITING_RECONCILIATION: "Waiting for reconciliation",
    USER_PAUSED: "Paused by user",
    RUNTIME_RESTART: "Waiting for runtime restart",
    FINAL_FAILURE: "Final failure",
  }
  return labels[attention.kind]
}

function runtimeAttentionDiagnostic(attention: MotryxAttentionItemProjection): string | undefined {
  const retry = attention.retryLayer
    ? `${attention.retryLayer.toLowerCase()} retry${attention.retryAttempt !== undefined
      ? ` ${attention.retryAttempt}${attention.retryLimit !== undefined ? `/${attention.retryLimit}` : ""}`
      : ""}`
    : undefined
  const values = [
    retry,
    attention.retryNotBefore !== undefined ? formatRetryTime(attention.retryNotBefore) : undefined,
    attention.reasonCode ? `reason ${attention.reasonCode}` : undefined,
    attention.failureKind ? `failure ${attention.failureKind}` : undefined,
    attention.httpStatus !== undefined ? `HTTP ${attention.httpStatus}` : undefined,
    attention.transportCode ? `transport ${attention.transportCode}` : undefined,
    attention.transportKind ? `kind ${attention.transportKind}` : undefined,
    attention.providerID && attention.modelID ? `${attention.providerID}/${attention.modelID}` : undefined,
    attention.nextAction ? `next ${attention.nextAction}` : undefined,
  ].filter((value): value is string => Boolean(value))
  return values.length > 0 ? values.join(" · ") : undefined
}

function runtimeAttentionColor(api: TuiPluginApi, severity: MotryxAttentionItemProjection["severity"]) {
  if (severity === "ERROR") return api.theme.current.error
  if (severity === "WARNING") return api.theme.current.warning
  return api.theme.current.info
}

function formatRetryTime(timestamp: number): string {
  return `next retry at ${new Date(timestamp).toISOString()}`
}

function formatRunInspection(run: MotryxControlSnapshot["runs"][number]): string {
  const values = [
    `${run.runKind}:${run.status}`,
    run.waitingKind ? `waiting ${run.waitingKind}${run.waitingRef ? ` (${run.waitingRef})` : ""}` : undefined,
    `error retry ${run.errorRetryCount}/${run.maxErrorRetries}`,
    `protocol correction ${run.protocolCorrectionCount}/${run.maxProtocolCorrections}`,
    run.retryNotBefore !== undefined ? formatRetryTime(run.retryNotBefore) : undefined,
    run.retryDisposition ? `disposition ${run.retryDisposition}` : undefined,
  ].filter((value): value is string => Boolean(value))
  return values.join(" · ")
}

function formatAttemptInspection(attempt: MotryxControlSnapshot["attempts"][number]): string {
  const values = [
    `Attempt #${attempt.attemptNo} ${attempt.reason}:${attempt.state}`,
    attempt.submitCount > 0 ? `delivery submissions ${attempt.submitCount}` : undefined,
    attempt.lastSubmitError ? `delivery ${attempt.lastSubmitError}` : undefined,
    attempt.hostAttemptCount !== undefined ? `provider attempt ${attempt.hostAttemptCount}` : undefined,
    attempt.failureSafeSummary,
    attempt.failureKind ? `failure ${attempt.failureKind}` : undefined,
    attempt.httpStatus !== undefined ? `HTTP ${attempt.httpStatus}` : undefined,
    attempt.transportCode ? `transport ${attempt.transportCode}` : undefined,
    attempt.transportKind ? `kind ${attempt.transportKind}` : undefined,
    attempt.providerID && attempt.modelID ? `${attempt.providerID}/${attempt.modelID}` : undefined,
    attempt.dispatchNotBefore !== undefined ? formatRetryTime(attempt.dispatchNotBefore) : undefined,
  ].filter((value): value is string => Boolean(value))
  return values.join(" · ")
}

function InspectPanel(props: {
  api: TuiPluginApi
  snapshot: MotryxControlSnapshot
  lane?: MotryxLaneProjection
  debugView: boolean
  projectionLive: boolean
  onConversation: (role: "coordinator" | "checker", laneID: string) => void
}) {
  const agents = createMemo(() =>
    props.snapshot.agents.filter((agent) => props.lane && agent.laneIDs.includes(props.lane.id)),
  )
  const artifacts = createMemo(() =>
    props.snapshot.artifacts.filter((artifact) => artifact.producedByLaneID === props.lane?.id),
  )
  const runs = createMemo(() => props.snapshot.runs.filter((run) =>
    run.laneID === props.lane?.id || run.relatedLaneID === props.lane?.id,
  ))
  const runIDs = createMemo(() => new Set(runs().map((run) => run.runID)))
  const attempts = createMemo(() => props.snapshot.attempts.filter((attempt) => runIDs().has(attempt.runID)))
  const attentionItems = createMemo(() => props.snapshot.attentionItems
    .filter((attention) => attention.laneID === props.lane?.id && attention.presentationState === "VISIBLE")
    .sort(compareRuntimeAttention))
  const primaryAttention = createMemo(() => attentionItems()[0])
  const failureAttention = createMemo(() => {
    const incidentID = props.lane?.failure?.incidentID
    if (!incidentID) return undefined
    return props.snapshot.attentionItems.find((attention) => attention.incidentID === incidentID)
  })
  const slots = createMemo(() => {
    const lane = props.lane
    if (!lane) return []
    const slotIDs = new Set([lane.coordinatorSlotID, lane.checkerSlotID].filter((item) => item !== undefined))
    return props.snapshot.functionSlots.filter((slot) => slotIDs.has(slot.slotID))
  })
  const dependencies = createMemo(() => {
    const ids = props.lane?.dependsOnLaneIDs ?? []
    if (ids.length === 0) return "none"
    const lanes = new Map(props.snapshot.lanes.map((lane) => [lane.id, lane.name]))
    const names = ids.flatMap((id) => {
      const name = lanes.get(id)
      return name ? [name] : []
    })
    const unavailable = ids.length - names.length
    if (unavailable > 0) names.push(`${unavailable} unavailable ${unavailable === 1 ? "dependency" : "dependencies"}`)
    return names.join(", ")
  })
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      verticalScrollbarOptions={{ visible: true }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <Show when={props.lane} fallback={<text fg={props.api.theme.current.textMuted}>Select a lane in FLOW.</text>}>
        {(lane) => (
          <box flexDirection="column" gap={1}>
            <text fg={props.api.theme.current.text}>{lane().name}</text>
            <text fg={laneColor(props.api, lane().status.toUpperCase())}>{motryxLaneStatusLabel(lane().status)}</text>
            <Show when={props.debugView}>
              <text fg={props.api.theme.current.warning}>DEBUG conversation</text>
              <box flexDirection="row" flexWrap="wrap" gap={1}>
                <DebugConversationChoice
                  api={props.api}
                  label="Open Coordinator"
                  enabled={
                    props.projectionLive &&
                    resolveProjectedDebugTarget(props.snapshot, lane().id, "coordinator") !== undefined
                  }
                  onPick={() => props.onConversation("coordinator", lane().id)}
                />
                <DebugConversationChoice
                  api={props.api}
                  label="Open Checker"
                  enabled={
                    props.projectionLive && resolveProjectedDebugTarget(props.snapshot, lane().id, "checker") !== undefined
                  }
                  onPick={() => props.onConversation("checker", lane().id)}
                />
              </box>
            </Show>
            <Show when={lane().pendingCheckSummary}>
              {(summary) => <InspectValue api={props.api} label="now" value={summary()} />}
            </Show>
            <Show when={primaryAttention()}>
              {(attention) => (
                <box flexDirection="column" gap={1}>
                  <text fg={runtimeAttentionColor(props.api, attention().severity)}>Runtime attention</text>
                  <InspectValue api={props.api} label="state" value={runtimeAttentionTitle(attention())} />
                  <InspectValue api={props.api} label="summary" value={attention().summary} />
                  <Show when={runtimeAttentionDiagnostic(attention())}>
                    {(detail) => <InspectValue api={props.api} label="diagnostic" value={detail()} />}
                  </Show>
                  <Show when={attention().nextAction}>
                    {(action) => <InspectValue api={props.api} label="next action" value={action()} />}
                  </Show>
                </box>
              )}
            </Show>
            <Show when={lane().failure}>
              {(failure) => (
                <box flexDirection="column" gap={1}>
                  <text fg={props.api.theme.current.error}>Runtime failure</text>
                  <InspectValue api={props.api} label="role" value={failure().role} />
                  <InspectValue api={props.api} label="kind" value={failure().kind} />
                  <InspectValue api={props.api} label="summary" value={failure().safeSummary} />
                  <InspectValue api={props.api} label="incident" value={failure().incidentID} />
                  <Show when={failureAttention()?.nextAction}>
                    {(action) => <InspectValue api={props.api} label="next action" value={action()} />}
                  </Show>
                </box>
              )}
            </Show>
            <InspectValue api={props.api} label="depends" value={dependencies()} />
            <InspectValue
              api={props.api}
              label="repair"
              value={`${lane().repairCycle} · reopen ${lane().reopenCount}`}
            />
            <InspectValue api={props.api} label="last activity" value={lane().updatedAt} />
            <InspectValue api={props.api} label="last check" value={lane().lastCheckResult ?? "not available"} />
            <InspectValue
              api={props.api}
              label="agents"
              value={
                agents()
                  .map((agent) => `${agent.role}:${agent.status}`)
                  .join(", ") || "none"
              }
            />
            <InspectValue
              api={props.api}
              label="artifacts"
              value={
                artifacts()
                  .map((artifact) => artifact.title)
                  .join(", ") || "none"
              }
            />
            <InspectValue
              api={props.api}
              label="function slots"
              value={
                slots()
                  .map((slot) => `${slot.slotKey}:${slot.runtimeReadiness}`)
                  .join(", ") || "none"
              }
            />
            <InspectValue
              api={props.api}
              label="runs"
              value={
                runs()
                  .map(formatRunInspection)
                  .join(", ") || "none"
              }
            />
            <InspectValue
              api={props.api}
              label="attempts"
              value={
                attempts()
                  .map(formatAttemptInspection)
                  .join(", ") || "none"
              }
            />
            <Show when={props.debugView}>
              <text fg={props.api.theme.current.warning}>DEBUG identity</text>
              <InspectValue api={props.api} label="lane" value={lane().id} />
              <InspectValue
                api={props.api}
                label="coordinator session"
                value={
                  resolveProjectedDebugTarget(props.snapshot, lane().id, "coordinator")?.sessionID ?? "not assigned"
                }
              />
              <InspectValue
                api={props.api}
                label="checker session"
                value={resolveProjectedDebugTarget(props.snapshot, lane().id, "checker")?.sessionID ?? "not assigned"}
              />
            </Show>
          </box>
        )}
      </Show>
    </scrollbox>
  )
}

function DebugConversationChoice(props: { api: TuiPluginApi; label: string; enabled: boolean; onPick: () => void }) {
  return (
    <box
      onMouseUp={props.enabled ? props.onPick : undefined}
      backgroundColor={props.enabled ? props.api.theme.current.backgroundElement : undefined}
    >
      <text fg={props.enabled ? props.api.theme.current.primary : props.api.theme.current.textMuted}>
        [{props.label}]
      </text>
    </box>
  )
}

function InspectValue(props: { api: TuiPluginApi; label: string; value: string }) {
  return (
    <box flexDirection="column">
      <text fg={props.api.theme.current.textMuted}>{props.label}</text>
      <text fg={props.api.theme.current.text} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}

export function resolveProjectedDebugTarget(
  snapshot: MotryxControlSnapshot,
  laneID: string,
  role: "coordinator" | "checker",
): MotryxConversationTarget | undefined {
  const lane = snapshot.lanes.find((item) => item.id === laneID)
  if (!lane) return undefined
  const slotID = role === "coordinator" ? lane.coordinatorSlotID : lane.checkerSlotID
  const readiness = role === "coordinator"
    ? lane.coordinatorRuntimeReadiness
    : lane.checkerRuntimeReadiness
  const runtime = role === "coordinator" ? lane.coordinatorRuntime : lane.checkerRuntime
  if (!slotID || readiness !== "ready" || !runtime || runtime.slotID !== slotID) return undefined
  const agents = snapshot.agents.filter(
    (item) =>
      item.instanceID === runtime.instanceID &&
      item.role === role &&
      item.status === "ALIVE" &&
      item.sessionID === runtime.sessionID &&
      item.orchestratorSessionID === snapshot.orchestratorSessionID,
  )
  if (agents.length !== 1) return undefined
  return {
    role,
    laneID,
    sessionID: runtime.sessionID,
    bindingGeneration: snapshot.binding.bindingGeneration,
    projectionRevision: snapshot.projectionRevision,
  }
}

function statusPresentation(phase: MotryxProjectionPhase) {
  if (phase === "live") return
  if (phase === "connecting") return "CONNECTING"
  if (phase === "starting") return "RECONCILING"
  if (phase === "auth-error") return "AUTH ERROR"
  if (phase === "schema-error") return "SCHEMA ERROR"
  if (phase === "unbound") return "UNBOUND"
  if (phase === "disposed") return "CLOSED"
  return "STALE"
}

function statusColor(api: TuiPluginApi, phase: MotryxProjectionPhase) {
  if (phase === "live") return api.theme.current.success
  if (phase === "connecting" || phase === "starting") return api.theme.current.warning
  if (phase === "disposed") return api.theme.current.textMuted
  return api.theme.current.error
}

function laneColor(api: TuiPluginApi, status: string) {
  if (status === "DONE") return api.theme.current.success
  if (status === "BLOCKED" || status === "FAILED") return api.theme.current.error
  if (
    status === "PENDING" || status === "CHECKING" || status === "AWAITING_CHECK" ||
    status === "READY" || status === "PREPARING"
  ) return api.theme.current.warning
  if (status === "WORKING") return api.theme.current.info
  return api.theme.current.textMuted
}

const MOTRYX_KNOWN_LANE_STATUSES = new Set([
  "OPEN",
  "WORKING",
  "AWAITING_CHECK",
  "CHECKING",
  "PENDING",
  "BLOCKED",
  "FAILED",
  "DONE",
  "WAIVED",
  "READY",
  "PREPARING",
])

export function motryxLaneStatusLabel(status: string) {
  const normalized = status.toUpperCase()
  if (normalized === "AWAITING_CHECK") return "AWAIT CHECK"
  const label = normalized.replaceAll("_", " ")
  return MOTRYX_KNOWN_LANE_STATUSES.has(normalized) ? label : `UNKNOWN · ${label}`
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function shortSessionID(value: string) {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`
}

export function motryxDebugViewFromEnv(env: Record<string, string | undefined> = process.env) {
  return env.MOTRYX_DEBUG_VIEW === "1"
}

export function motryxRouteConfig(env: Record<string, string | undefined> = process.env) {
  return motryxControlConfigFromEnv(env)
}
