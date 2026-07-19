/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { MotryxRoute, motryxRouteConfig } from "./route"

export const MOTRYX_ROUTE = "motryx"

const tui: TuiPlugin = async (api) => {
  const config = motryxRouteConfig()
  let refresh: (() => Promise<void>) | undefined

  api.route.register([
    {
      name: MOTRYX_ROUTE,
      render: () => (
        <MotryxRoute
          api={api}
          config={config.ok ? config.value : undefined}
          configError={config.ok ? undefined : config.error}
          onRefreshAvailable={(next) => {
            refresh = next
          }}
        />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "motryx.open",
        title: "Open Motryx workflow",
        description: "Open the read-only Motryx workflow and lane projection.",
        slashName: "motryx",
        category: "Motryx",
        namespace: "palette",
        run() {
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
          if (!config.ok) {
            api.ui.toast({ variant: "error", message: config.error })
            return
          }
          api.route.navigate("session", { sessionID: config.value.orchestratorSessionID })
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
          if (!refresh) {
            api.route.navigate(MOTRYX_ROUTE)
            return
          }
          void refresh()
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id: MOTRYX_ROUTE,
  tui,
  enabled: false,
}

export default plugin
