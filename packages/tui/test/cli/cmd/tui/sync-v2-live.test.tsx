/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { Event, GlobalEvent, SessionMessage } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../../src/context/args"
import { DataProvider } from "../../../../src/context/data"
import { ExitProvider } from "../../../../src/context/exit"
import { KVProvider } from "../../../../src/context/kv"
import { PermissionProvider } from "../../../../src/context/permission"
import { ProjectProvider } from "../../../../src/context/project"
import { TuiStartupProvider } from "../../../../src/context/runtime"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { tmpdir } from "../../../fixture/fixture"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../../fixture/tui-sdk"
import { wait } from "./sync-fixture"

const sessionID = "ses_v2_live"
const model = { providerID: "zai-coding-plan", id: "glm-5.2", variant: "default" }

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

test("projects external V2 turns incrementally and preserves the exact session across reconnect and instance refresh", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const persisted: SessionMessage[] = [{ id: "msg_user_1", type: "user", text: "start", time: { created: 1 } }]
  let messageReads = 0
  let providerAuthReads = 0
  let currentModel = model
  const calls = createFetch((url) => {
    if (url.pathname === "/provider/auth") providerAuthReads++
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          title: "V2 live session",
          agent: "orchestrator",
          model: currentModel,
          location: { directory },
          execution: { managed: true, gateOpen: true },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) {
      messageReads++
      return json({ data: structuredClone(persisted), cursor: null })
    }
    if (
      url.pathname === `/api/session/${sessionID}/permission` ||
      url.pathname === `/api/session/${sessionID}/question`
    )
      return json({ data: [] })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    return undefined
  }, events)
  let sync!: ReturnType<typeof useSync>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSync()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={{ state: tmp.path }}>
      <TuiStartupProvider value={{ skipInitialLoading: false, sessionApi: "v2" }}>
        <ArgsProvider>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
              <PermissionProvider>
                <ProjectProvider>
                  <DataProvider>
                    <ExitProvider exit={() => {}}>
                      <SyncProvider>
                        <Probe />
                      </SyncProvider>
                    </ExitProvider>
                  </DataProvider>
                </ProjectProvider>
              </PermissionProvider>
            </SDKProvider>
          </KVProvider>
        </ArgsProvider>
      </TuiStartupProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => sync.status === "complete")
    await sync.session.sync(sessionID)
    const first = sync.data.message[sessionID][0]
    expect(first.id).toBe("msg_user_1")

    events.emit(
      global({
        id: "evt_step_started",
        type: "session.next.step.started",
        properties: {
          sessionID,
          assistantMessageID: "msg_assistant_1",
          timestamp: 2,
          agent: "orchestrator",
          model,
        },
      }),
    )
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === "msg_assistant_1"))
    expect(sync.data.message[sessionID][0]).toBe(first)

    events.emit(
      global({
        id: "evt_text_started",
        type: "session.next.text.started",
        properties: {
          sessionID,
          assistantMessageID: "msg_assistant_1",
          textID: "text_1",
          timestamp: 3,
        },
      }),
    )
    await wait(() => sync.data.part.msg_assistant_1?.length === 1)
    const assistant = sync.data.message[sessionID].find((message) => message.id === "msg_assistant_1")!
    const text = sync.data.part.msg_assistant_1[0]

    events.emit(
      global({
        id: "evt_text_delta",
        type: "session.next.text.delta",
        properties: {
          sessionID,
          assistantMessageID: "msg_assistant_1",
          textID: "text_1",
          timestamp: 4,
          delta: "live update",
        },
      }),
    )
    await wait(
      () =>
        sync.data.part.msg_assistant_1?.[0]?.type === "text" &&
        sync.data.part.msg_assistant_1[0].text === "live update",
    )
    expect(sync.data.message[sessionID].find((message) => message.id === "msg_assistant_1")).toBe(assistant)
    expect(sync.data.part.msg_assistant_1[0]).toBe(text)
    expect(messageReads).toBe(1)

    currentModel = { providerID: "new-provider", id: "new-model", variant: "high" }
    events.emit(
      global({
        id: "evt_model_requested",
        type: "session.next.model.switch.requested",
        properties: { sessionID, timestamp: 5, model: currentModel },
      }),
    )
    await Bun.sleep(20)
    expect(sync.session.get(sessionID)?.model).toEqual(model)
    events.emit(
      global({
        id: "evt_model_switched",
        type: "session.next.model.switched",
        properties: { sessionID, messageID: "msg_model_switched", timestamp: 6, model: currentModel },
      }),
    )
    await wait(() => sync.session.get(sessionID)?.model?.providerID === "new-provider")
    expect(sync.session.get(sessionID)?.model).toEqual(currentModel)
    expect(messageReads).toBe(1)
    persisted.push({ id: "msg_model_switched", type: "model-switched", model: currentModel, time: { created: 6 } })

    persisted.push({
      id: "msg_assistant_recovered",
      type: "assistant",
      agent: "orchestrator",
      model,
      content: [{ type: "text", id: "text_recovered", text: "recovered" }],
      time: { created: 5, completed: 6 },
      finish: "stop",
    })
    // A selection applied while disconnected must be recovered from the Session readback.
    currentModel = { providerID: "reconnected-provider", id: "reconnected-model", variant: "default" }
    events.emit(global({ id: "evt_reconnected", type: "server.connected", properties: {} }))

    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === "msg_assistant_recovered"))
    expect(messageReads).toBe(2)
    expect(sync.data.message[sessionID][0]).toBe(first)
    await wait(() => sync.session.get(sessionID)?.model?.providerID === "reconnected-provider")
    expect(sync.session.get(sessionID)?.model).toEqual(currentModel)

    const authReadsBeforeDispose = providerAuthReads
    events.emit(global({ id: "evt_instance_disposed", type: "server.instance.disposed", properties: { directory } }))
    await wait(() => providerAuthReads > authReadsBeforeDispose)
    expect(sync.session.get(sessionID)?.id).toBe(sessionID)
    expect(sync.data.message[sessionID]?.some((message) => message.id === "msg_assistant_recovered")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
