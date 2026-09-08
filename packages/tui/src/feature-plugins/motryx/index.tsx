/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { DialogProvider } from "../../component/dialog-provider"
import { DialogModel, type DialogModelSelection } from "../../component/dialog-model"
import { MotryxRoute, motryxDebugViewFromEnv, motryxRouteConfig, type MotryxRouteActions } from "./route"
import { createMotryxPromptAdmissionHandler } from "./prompt-admission-reconcile"
import {
  motryxModelSetCommandFromEnv,
  setMotryxModelTier,
  type MotryxModelSetCommandResult,
  type MotryxModelTier,
} from "./model-config"

export const MOTRYX_ROUTE = "motryx"
export const MOTRYX_PRODUCT_COMMAND_PRIORITY = 100

const tui: TuiPlugin = async (api) => {
  const config = motryxRouteConfig()
  const debugView = motryxDebugViewFromEnv()
  let actions: MotryxRouteActions | undefined

  if (config.ok) {
    api.prompt.interceptAdmission(
      createMotryxPromptAdmissionHandler(config.value, {
        signal: api.lifecycle.signal,
        onWaiting() {
          api.ui.toast({
            variant: "info",
            title: "Motryx route is reconnecting",
            message: "Your prompt is preserved and submission will resume when the exact route is available.",
          })
        },
        onReconciled() {
          api.ui.toast({ variant: "success", message: "Motryx route reconciled and the prompt was admitted." })
        },
      }),
    )
  }

  api.route.register([
    {
      name: MOTRYX_ROUTE,
      render: () => (
        <MotryxRoute
          api={api}
          config={config.ok ? config.value : undefined}
          configError={config.ok ? undefined : config.error}
          debugView={debugView}
          onActionsAvailable={(next) => {
            actions = next
          }}
        />
      ),
    },
  ])

  api.keymap.registerLayer({
    // The Motryx product policy must win over the generic session navigation
    // commands while this disabled-by-default product plugin is active.
    priority: MOTRYX_PRODUCT_COMMAND_PRIORITY,
    commands: [
      ...motryxSessionNavigationCommands(api, config, () => actions),
      ...motryxSelectionBoundaryCommands(api, motryxModelSetCommandFromEnv(), () => actions?.modelApplicationRoute()),
      {
        name: "motryx.open",
        title: "Open Motryx workflow",
        description: "Open the read-only Motryx workflow and lane projection.",
        slashName: "motryx",
        category: "Motryx",
        namespace: "palette",
        run() {
          if (actions) {
            actions.showFlow()
            api.ui.dialog.clear()
            return
          }
          api.route.navigate(MOTRYX_ROUTE)
          api.ui.dialog.clear()
        },
      },
      {
        name: "motryx.refresh",
        title: "Refresh Motryx projection",
        description: "Re-read the exact typed control-plane snapshot.",
        slashName: "motryx-refresh",
        category: "Motryx",
        namespace: "palette",
        run() {
          if (!actions) {
            api.route.navigate(MOTRYX_ROUTE)
            return
          }
          void actions.refresh()
        },
      },
      {
        name: "motryx.flow",
        title: "Show Motryx flow",
        slashName: "motryx-flow",
        category: "Motryx",
        namespace: "palette",
        run: () => actions?.showFlow(),
      },
      {
        name: "motryx.inspect",
        title: "Inspect selected Motryx lane",
        slashName: "motryx-inspect",
        category: "Motryx",
        namespace: "palette",
        run: () => actions?.showInspect(),
      },
      {
        name: "motryx.incidents",
        title: "Show Motryx runtime incidents",
        slashName: "motryx-incidents",
        category: "Motryx",
        namespace: "palette",
        run: () => actions?.showIncidents(),
      },
      {
        name: "motryx.incident.dismiss_latest",
        title: "Dismiss latest Motryx runtime error card",
        slashName: "motryx-dismiss-error",
        category: "Motryx",
        namespace: "palette",
        run: () => actions?.dismissLatestIncident(),
      },
      {
        name: "motryx.target.orchestrator",
        title: "Show Orchestrator conversation",
        slashName: "motryx-orchestrator",
        category: "Motryx debug",
        namespace: "palette",
        run: () => actions?.focusOrchestrator(),
      },
      {
        name: "motryx.target.coordinator",
        title: "Show selected lane Coordinator conversation",
        category: "Motryx debug",
        namespace: "palette",
        hidden: !debugView,
        run: () => actions?.focusCoordinator(),
      },
      {
        name: "motryx.target.checker",
        title: "Show selected lane Checker conversation",
        category: "Motryx debug",
        namespace: "palette",
        hidden: !debugView,
        run: () => actions?.focusChecker(),
      },
      {
        name: "motryx.lane.previous",
        title: "Select previous Motryx lane",
        slashName: "motryx-lane-previous",
        category: "Motryx",
        namespace: "palette",
        run: () => actions?.moveLane(-1),
      },
      {
        name: "motryx.lane.next",
        title: "Select next Motryx lane",
        slashName: "motryx-lane-next",
        category: "Motryx",
        namespace: "palette",
        run: () => actions?.moveLane(1),
      },
    ],
    bindings: [
          { key: "alt+x", cmd: "motryx.incident.dismiss_latest", desc: "Dismiss latest runtime error card" },
          ...(debugView ? [
          { key: "alt+1", cmd: "motryx.target.orchestrator", desc: "Show Orchestrator conversation" },
          { key: "alt+2", cmd: "motryx.target.coordinator", desc: "Show Coordinator conversation" },
          { key: "alt+3", cmd: "motryx.target.checker", desc: "Show Checker conversation" },
          ] : []),
        ],
  })
}

type MotryxRouteConfigResult = ReturnType<typeof motryxRouteConfig>
type TuiKeymapCommand = NonNullable<Parameters<TuiPluginApi["keymap"]["registerLayer"]>[0]["commands"]>[number]

export function motryxSessionNavigationCommands(
  api: TuiPluginApi,
  config: MotryxRouteConfigResult,
  actions: () => MotryxRouteActions | undefined,
): TuiKeymapCommand[] {
  return [
    {
      name: "session.list",
      title: "Motryx Orchestrators",
      description: "List and switch resumable Motryx Orchestrator conversations.",
      slashName: "sessions",
      slashAliases: ["resume", "continue"],
      category: "Motryx",
      namespace: "palette",
      run() {
        const current = actions()
        if (current) {
          void current.showSessions()
          return
        }
        showBoundConversation(api, config, actions)
      },
    },
    {
      name: "session.rename",
      title: "Rename Motryx Orchestrator",
      description: "Rename the current launcher-bound Motryx Orchestrator conversation.",
      slashName: "rename",
      category: "Motryx",
      namespace: "palette",
      run() {
        const current = actions()
        if (current) {
          void current.rename()
          return
        }
        showBoundConversation(api, config, actions)
      },
    },
    {
      name: "session.new",
      title: "New Motryx conversation",
      category: "Motryx",
      namespace: "palette",
      hidden: true,
      run() {
        explainLauncherOwnedConversation(api)
      },
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      name: `session.quick_switch.${index + 1}`,
      title: `Motryx conversation quick slot ${index + 1}`,
      category: "Motryx",
      namespace: "palette" as const,
      hidden: true,
      run() {
        const current = actions()
        if (current) {
          current.focusOrchestrator()
          return
        }
        explainLauncherOwnedConversation(api)
      },
    })),
  ]
}

export function motryxSelectionBoundaryCommands(
  api: TuiPluginApi,
  modelSetCommand: MotryxModelSetCommandResult = motryxModelSetCommandFromEnv(),
  currentRoute: MotryxRouteActions["modelApplicationRoute"] = () => undefined,
): TuiKeymapCommand[] {
  let modelSetPending = false
  let savedStrongModel: string | undefined
  let savedWeakModel: string | undefined
  const modelBoundary = () =>
    api.ui.toast({
      variant: "info",
      message:
        "Motryx model tiers are launcher-owned. Use /strong_model or /weak_model for the exact configuration command.",
    })
  const agentBoundary = () =>
    api.ui.toast({
      variant: "info",
      message: "Motryx agents are assigned by the IC sidecar and cannot be switched from the conversation TUI.",
    })
  const historyBoundary = () =>
    api.ui.toast({
      variant: "info",
      message: "Motryx does not expose fork, compact, undo, or redo in its multi-agent conversation.",
    })

  return [
    {
      name: "model.list",
      title: "Motryx model tiers",
      category: "Motryx",
      namespace: "palette",
      hidden: true,
      run: modelBoundary,
    },
    {
      name: "motryx.model.strong",
      title: "Configure strong model",
      description: "Select the launcher-owned model tier used by Orchestrator and Analyst.",
      slashName: "strong_model",
      category: "Motryx",
      namespace: "palette",
      run() {
        showMotryxModelPicker(
          api,
          modelSetCommand,
          currentRoute,
          "strong",
          savedStrongModel ?? api.state.config.model,
          () => modelSetPending,
          (value) => {
            modelSetPending = value
          },
          (model) => {
            savedStrongModel = model
          },
        )
      },
    },
    {
      name: "motryx.model.weak",
      title: "Configure weak model",
      description: "Select the launcher-owned model tier used by Coordinator and Checker.",
      slashName: "weak_model",
      category: "Motryx",
      namespace: "palette",
      run() {
        showMotryxModelPicker(
          api,
          modelSetCommand,
          currentRoute,
          "weak",
          savedWeakModel ?? api.state.config.small_model,
          () => modelSetPending,
          (value) => {
            modelSetPending = value
          },
          (model) => {
            savedWeakModel = model
          },
        )
      },
    },
    ...["model.cycle_recent", "model.cycle_recent_reverse", "model.cycle_favorite", "model.cycle_favorite_reverse"].map(
      (name) => ({
        name,
        title: "Motryx model tiers",
        category: "Motryx",
        namespace: "palette" as const,
        hidden: true,
        run: modelBoundary,
      }),
    ),
    ...["agent.list", "agent.cycle", "agent.cycle.reverse"].map((name) => ({
      name,
      title: "Motryx agent assignment",
      category: "Motryx",
      namespace: "palette" as const,
      hidden: true,
      run: agentBoundary,
    })),
    ...["variant.list", "variant.cycle"].map((name) => ({
      name,
      title: "Motryx model tiers",
      category: "Motryx",
      namespace: "palette" as const,
      hidden: true,
      run: modelBoundary,
    })),
    {
      name: "provider.connect",
      title: "Connect provider",
      description: "Connect a provider using OpenCode authentication.",
      slashName: "connect",
      category: "Provider",
      namespace: "palette",
      run() {
        api.ui.dialog.replace(() => (
          <DialogProvider
            onConnected={() => {
              api.ui.dialog.clear()
              api.ui.toast({
                variant: "success",
                message: "Provider credential saved. Motryx strong and weak models are unchanged.",
              })
            }}
          />
        ))
      },
    },
    ...["session.fork", "session.compact", "session.undo", "session.redo"].map((name) => ({
      name,
      title: "Motryx conversation history boundary",
      category: "Motryx",
      namespace: "palette" as const,
      hidden: true,
      run: historyBoundary,
    })),
  ]
}

function showMotryxModelPicker(
  api: TuiPluginApi,
  command: MotryxModelSetCommandResult,
  currentRoute: MotryxRouteActions["modelApplicationRoute"],
  tier: MotryxModelTier,
  configured: string | undefined,
  pending: () => boolean,
  setPending: (value: boolean) => void,
  onSaved: (model: string) => void,
) {
  if (!command.ok) {
    api.ui.toast({ variant: "error", message: command.error })
    return
  }
  const expected = currentRoute()
  if (!expected) {
    api.ui.toast({ variant: "error", message: "The Motryx route is not live. Reconnect before selecting a model." })
    return
  }
  const current = parseConfiguredModel(configured)
  api.ui.dialog.replace(() => (
    <DialogModel
      title={`Select ${tier} model`}
      current={current}
      onSelect={async (selection) => {
        if (pending()) return
        setPending(true)
        const model = `${selection.providerID}/${selection.modelID}`
        try {
          const result = await setMotryxModelTier(command.value, tier, model, { expected, signal: api.lifecycle.signal })
          if (JSON.stringify(currentRoute()) !== JSON.stringify(expected)) return
          onSaved(result.selection.model)
          api.ui.dialog.clear()
          const selection = `${result.selection.model}#${result.selection.variant}`
          api.ui.toast({
            variant: result.status === "partial" || result.status === "unconfirmed" ? "error" : "success",
            message: result.status === "offline" ? `${tier} preference saved: ${selection}. No running instance.`
              : result.status === "unconfirmed" ? `${tier} preference saved. Online application unconfirmed: ${result.message}`
                : result.status === "partial" ? `${tier} preference saved. Unconfirmed requests: ${result.unconfirmed.map((item) => `${item.sessionID}: ${item.message}`).join("; ")}`
                  : result.accepted.length === 0 ? `${tier} preference saved: ${selection}. No attached target sessions.`
                    : result.accepted.every((item) => item.applied) ? `${tier} model applied: ${selection}.`
                      : `${tier} model requests accepted: ${selection}. Waiting for active turns to finish.`,
          })
        } catch (error) {
          if (JSON.stringify(currentRoute()) !== JSON.stringify(expected)) return
          api.ui.toast({
            variant: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          setPending(false)
        }
      }}
    />
  ))
}

function parseConfiguredModel(value: string | undefined): DialogModelSelection | undefined {
  if (!value) return
  const [providerID, ...parts] = value.split("/")
  const modelID = parts.join("/")
  if (!providerID || !modelID) return
  return { providerID, modelID }
}

function showBoundConversation(
  api: Parameters<TuiPlugin>[0],
  config: MotryxRouteConfigResult,
  actions: () => MotryxRouteActions | undefined,
) {
  if (!config.ok) {
    api.ui.toast({ variant: "error", message: config.error })
    return
  }
  const session = api.state.session.get(config.value.orchestratorSessionID)
  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title="Motryx Orchestrators"
      options={[
        {
          title: session?.title || "Orchestrator",
          value: config.value.orchestratorSessionID,
          description: "Current launcher-bound Orchestrator",
          category: "Motryx",
        },
      ]}
      current={config.value.orchestratorSessionID}
      skipFilter
      onSelect={() => {
        const current = actions()
        if (current) current.focusOrchestrator()
        else api.route.navigate(MOTRYX_ROUTE)
        api.ui.dialog.clear()
      }}
    />
  ))
}

function explainLauncherOwnedConversation(api: Parameters<TuiPlugin>[0]) {
  api.ui.toast({
    variant: "info",
    message: "Motryx conversations are created and bound by the launcher.",
  })
}

const plugin: BuiltinTuiPlugin = {
  id: MOTRYX_ROUTE,
  tui,
  enabled: false,
}

export default plugin
