/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { motryxSelectionBoundaryCommands, motryxSessionNavigationCommands } from "../../src/feature-plugins/motryx"
import type { MotryxRouteActions } from "../../src/feature-plugins/motryx/route"
import { createTuiPluginApi } from "../fixture/tui-plugin"

test("Motryx session navigation delegates /sessions to the routed product switcher", () => {
  let opened = 0
  const base = createTuiPluginApi()
  const actions = {
    async showSessions() {
      opened += 1
    },
  } as unknown as MotryxRouteActions
  const commands = motryxSessionNavigationCommands(
    base,
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
  expect(opened).toBe(1)
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

test("Motryx preserves OpenCode provider connect while keeping model and agent selection launcher-owned", () => {
  const notices: string[] = []
  let providerDialogs = 0
  const base = createTuiPluginApi()
  const api = {
    ...base,
    state: {
      ...base.state,
      config: {
        ...base.state.config,
        model: "openai/gpt-5.5",
        small_model: "zai-coding-plan/glm-5.2",
      },
    },
    ui: {
      ...base.ui,
      dialog: {
        ...base.ui.dialog,
        replace() {
          providerDialogs += 1
        },
      },
      toast(input: { message: string }) {
        notices.push(input.message)
      },
    },
  } as unknown as TuiPluginApi
  const commands = motryxSelectionBoundaryCommands(api)

  const generic = commands.find((command) => command.name === "model.list")
  expect(generic?.hidden).toBe(true)
  expect(generic?.slashName).toBeUndefined()
  generic?.run({} as never)

  const strong = commands.find((command) => command.name === "motryx.model.strong")
  const weak = commands.find((command) => command.name === "motryx.model.weak")
  expect(strong?.slashName).toBe("strong_model")
  expect(weak?.slashName).toBe("weak_model")
  strong?.run({} as never)
  weak?.run({} as never)

  commands.find((command) => command.name === "agent.list")?.run({} as never)
  const connect = commands.find((command) => command.name === "provider.connect")
  expect(connect?.slashName).toBe("connect")
  expect(connect?.hidden).not.toBe(true)
  connect?.run({} as never)
  expect(providerDialogs).toBe(1)
  for (const name of ["session.fork", "session.compact", "session.undo", "session.redo"])
    commands.find((command) => command.name === name)?.run({} as never)
  expect(notices).toEqual([
    "Motryx model tiers are launcher-owned. Use /strong_model or /weak_model for the exact configuration command.",
    "strong model: openai/gpt-5.5. To change it, run motryx models set strong <provider/model> outside the TUI, then relaunch.",
    "weak model: zai-coding-plan/glm-5.2. To change it, run motryx models set weak <provider/model> outside the TUI, then relaunch.",
    "Motryx agents are assigned by the IC sidecar and cannot be switched from the conversation TUI.",
    "Motryx does not expose fork, compact, undo, or redo in its multi-agent conversation.",
    "Motryx does not expose fork, compact, undo, or redo in its multi-agent conversation.",
    "Motryx does not expose fork, compact, undo, or redo in its multi-agent conversation.",
    "Motryx does not expose fork, compact, undo, or redo in its multi-agent conversation.",
  ])
})
