/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { MotryxRoute, motryxDebugViewFromEnv, motryxRouteConfig, type MotryxRouteActions } from "./route"
import { createMotryxPromptAdmissionHandler } from "./prompt-recovery"

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
            title: "Motryx is recovering",
            message: "Your prompt is preserved and will be retried when the exact route is available.",
          })
        },
        onRecovered() {
          api.ui.toast({ variant: "success", message: "Motryx recovered and the prompt was admitted." })
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
      ...motryxSelectionBoundaryCommands(api),
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
    bindings: debugView
      ? [
          { key: "alt+1", cmd: "motryx.target.orchestrator", desc: "Show Orchestrator conversation" },
          { key: "alt+2", cmd: "motryx.target.coordinator", desc: "Show Coordinator conversation" },
          { key: "alt+3", cmd: "motryx.target.checker", desc: "Show Checker conversation" },
        ]
      : [],
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

export function motryxSelectionBoundaryCommands(api: TuiPluginApi): TuiKeymapCommand[] {
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
  const providerBoundary = () =>
    api.ui.toast({
      variant: "info",
      message: "Motryx provider credentials are provisioned before launch and cannot be changed from the TUI.",
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
      title: "Show strong model configuration",
      description: "Show the launcher-owned model tier used by Orchestrator and Analyst.",
      slashName: "strong_model",
      category: "Motryx",
      namespace: "palette",
      run() {
        explainLauncherOwnedModel(api, "strong", api.state.config.model)
      },
    },
    {
      name: "motryx.model.weak",
      title: "Show weak model configuration",
      description: "Show the launcher-owned model tier used by Coordinator, Checker, and helpers.",
      slashName: "weak_model",
      category: "Motryx",
      namespace: "palette",
      run() {
        explainLauncherOwnedModel(api, "weak", api.state.config.small_model)
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
      title: "Motryx provider provisioning",
      category: "Motryx",
      namespace: "palette",
      hidden: true,
      run: providerBoundary,
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

function explainLauncherOwnedModel(api: TuiPluginApi, tier: "strong" | "weak", model: string | undefined) {
  api.ui.toast({
    variant: "info",
    message: `${tier} model: ${model ?? "not configured"}. To change it, run motryx models set ${tier} <provider/model> outside the TUI, then relaunch.`,
  })
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
