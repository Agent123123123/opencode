/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { MotryxRoute, motryxDebugViewFromEnv, motryxRouteConfig, type MotryxRouteActions } from "./route"

export const MOTRYX_ROUTE = "motryx"
export const MOTRYX_PRODUCT_COMMAND_PRIORITY = 100

const tui: TuiPlugin = async (api) => {
  const config = motryxRouteConfig()
  const debugView = motryxDebugViewFromEnv()
  let actions: MotryxRouteActions | undefined

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
        name: "motryx.session",
        title: "Open Motryx orchestrator conversation",
        description: "Open the exact orchestrator in the standard OpenCode session surface.",
        slashName: "motryx-session",
        category: "Motryx",
        namespace: "palette",
        run() {
          if (actions) {
            actions.focusOrchestrator()
            api.ui.dialog.clear()
            return
          }
          if (!config.ok) {
            api.ui.toast({ variant: "error", message: config.error })
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
      title: "Motryx conversation",
      description: "Show the exact launcher-bound Orchestrator conversation.",
      slashName: "sessions",
      slashAliases: ["resume", "continue"],
      category: "Motryx",
      namespace: "palette",
      run() {
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
      title="Conversations"
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
