/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { LocationProvider } from "../../../src/context/location"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { ArgsProvider } from "../../../src/context/args"
import { DataProvider } from "../../../src/context/data"
import { ExitProvider } from "../../../src/context/exit"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SyncProvider } from "../../../src/context/sync"
import { QuestionPrompt } from "../../../src/routes/session/question"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { TuiStartupProvider } from "../../../src/context/runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { tmpdir } from "../../fixture/fixture"

test("a bounded question preserves its controls and reveals the keyboard-selected answer", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch(
    (url) => (url.pathname === "/api/session/active" ? Response.json({ data: {} }) : undefined),
    events,
  )
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <TuiStartupProvider value={{ sessionApi: "v2", skipInitialLoading: false }}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <box height={17}>
                      <text height={3}>TRANSCRIPT</text>
                      <QuestionPrompt
                        heightLimit={12}
                        request={{
                          id: "que_layout",
                          sessionID: "ses_layout",
                          questions: [
                            {
                              header: "Layout",
                              question: "Long question explanation. ".repeat(20),
                              options: Array.from({ length: 5 }, (_, i) => ({
                                label: `Option ${i + 1}`,
                                description: "Long description. ".repeat(8),
                              })),
                            },
                          ],
                        }}
                      />
                      <text>FLOW_BOUNDARY</text>
                    </box>
                  </SDKProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </TuiStartupProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(Harness, { width: 60, height: 17 })
  try {
    for (let i = 0; i < 50 && !app.captureCharFrame().includes("enter submit"); i++) {
      await Bun.sleep(10)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toContain("enter submit")
    expect(app.captureCharFrame()).toContain("TRANSCRIPT")
    expect(app.captureCharFrame()).toContain("FLOW_BOUNDARY")
    for (let i = 0; i < 4; i++) app.mockInput.pressArrow("down")
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Option 5")
    expect(app.captureCharFrame()).toContain("enter submit")
    expect(app.captureCharFrame()).toContain("FLOW_BOUNDARY")
  } finally {
    app.renderer.destroy()
  }
})

test("a bounded permission preserves its allow/reject controls below a long description", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch(
    (url) => (url.pathname === "/api/session/active" ? Response.json({ data: {} }) : undefined),
    events,
  )
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <TuiStartupProvider value={{ sessionApi: "v2", skipInitialLoading: false }}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                    <ArgsProvider>
                      <PermissionProvider>
                        <ProjectProvider>
                          <DataProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <LocationProvider>
                                  <box height={17}>
                                    <text height={3}>TRANSCRIPT</text>
                                    <PermissionPrompt
                                      heightLimit={12}
                                      request={{
                                        id: "per_layout",
                                        sessionID: "ses_layout",
                                        permission: "custom",
                                        patterns: ["Long permission description. ".repeat(30)],
                                        always: ["*"],
                                        metadata: {},
                                      }}
                                    />
                                    <text>FLOW_BOUNDARY</text>
                                  </box>
                                </LocationProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </DataProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </ArgsProvider>
                  </SDKProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </TuiStartupProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(Harness, { width: 60, height: 17 })
  try {
    for (let i = 0; i < 50 && !app.captureCharFrame().includes("Allow once"); i++) {
      await Bun.sleep(10)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toContain("Allow once")
    expect(app.captureCharFrame()).toContain("TRANSCRIPT")
    expect(app.captureCharFrame()).toContain("FLOW_BOUNDARY")
    expect(app.captureCharFrame()).toContain("Allow always")
    expect(app.captureCharFrame()).toContain("Reject")
    expect(app.captureCharFrame()).toContain("confirm")
  } finally {
    app.renderer.destroy()
  }
})
