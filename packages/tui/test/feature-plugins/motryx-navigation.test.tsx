/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiDialogSelectProps, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { motryxSessionNavigationCommands } from "../../src/feature-plugins/motryx"
import type { MotryxRouteActions } from "../../src/feature-plugins/motryx/route"
import { createTuiPluginApi } from "../fixture/tui-plugin"

test("Motryx session navigation exposes only the exact launcher-bound Orchestrator", () => {
  let dialogRender: (() => unknown) | undefined
  let select: TuiDialogSelectProps<string> | undefined
  let cleared = 0
  let focused = 0
  const base = createTuiPluginApi()
  const api = {
    ...base,
    state: {
      ...base.state,
      session: {
        ...base.state.session,
        get: () => ({ title: "Bound Orchestrator" }),
      },
    },
    ui: {
      ...base.ui,
      DialogSelect(props: TuiDialogSelectProps<string>) {
        select = props
        return undefined as never
      },
      dialog: {
        ...base.ui.dialog,
        replace(render: () => unknown) {
          dialogRender = render
        },
        clear() {
          cleared += 1
        },
      },
    },
  } as unknown as TuiPluginApi
  const actions = { focusOrchestrator: () => (focused += 1) } as unknown as MotryxRouteActions
  const commands = motryxSessionNavigationCommands(
    api,
    {
      ok: true,
      value: {
        apiURL: "http://127.0.0.1:1234/",
        token: "secret",
        projectID: "/tmp/project",
        orchestratorSessionID: "ses_orchestrator",
      },
    },
    () => actions,
  )

  const list = commands.find((command) => command.name === "session.list")
  expect(list?.slashName).toBe("sessions")
  expect(list?.slashAliases).toEqual(["resume", "continue"])
  list?.run({} as never)
  expect(dialogRender).toBeDefined()
  dialogRender?.()

  expect(select?.options).toEqual([
    {
      title: "Bound Orchestrator",
      value: "ses_orchestrator",
      description: "Current launcher-bound Orchestrator",
      category: "Motryx",
    },
  ])
  expect(JSON.stringify(select?.options)).not.toContain("coordinator")
  expect(JSON.stringify(select?.options)).not.toContain("checker")
  select?.onSelect?.(select.options[0]!)
  expect(focused).toBe(1)
  expect(cleared).toBe(1)
})

test("Motryx blocks generic new-session and quick-slot navigation", () => {
  const notices: string[] = []
  let focused = 0
  const base = createTuiPluginApi()
  const api = {
    ...base,
    ui: {
      ...base.ui,
      toast(input: { message: string }) {
        notices.push(input.message)
      },
    },
  } as unknown as TuiPluginApi
  let actions: MotryxRouteActions | undefined
  const commands = motryxSessionNavigationCommands(api, { ok: false, error: "unbound" }, () => actions)

  commands.find((command) => command.name === "session.new")?.run({} as never)
  commands.find((command) => command.name === "session.quick_switch.1")?.run({} as never)
  expect(notices).toEqual([
    "Motryx conversations are created and bound by the launcher.",
    "Motryx conversations are created and bound by the launcher.",
  ])

  actions = { focusOrchestrator: () => (focused += 1) } as unknown as MotryxRouteActions
  commands.find((command) => command.name === "session.quick_switch.9")?.run({} as never)
  expect(focused).toBe(1)
})
