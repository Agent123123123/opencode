import type {
  LocationRef,
  PermissionV2Request,
  QuestionV2Request,
  ReferenceInfo,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2"
import { DateTime, Option } from "effect"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { batch, createSignal, onCleanup, onMount } from "solid-js"

import { createSessionMessageHistory } from "./session-message-history"

type LocationData = {
  reference?: ReferenceInfo[]
}

type ProviderRetry = Extract<V2Event, { type: "session.next.retried" }>["data"]
type SessionRuntime = { turnID?: string; messageID?: string; terminal: boolean; seq: number; retry?: ProviderRetry }

type Data = {
  session: {
    info: Record<string, SessionV2Info>
    message: Record<string, SessionMessage[]>
    messageRevision: Record<string, number>
    permission: Record<string, PermissionV2Request[]>
    question: Record<string, QuestionV2Request[]>
    runtime: Record<string, SessionRuntime>
  }
  location: Record<string, LocationData>
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

export const {
  use: useData,
  useOptional: useOptionalData,
  provider: DataProvider,
} = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Data>({
      session: {
        info: {},
        message: {},
        messageRevision: {},
        permission: {},
        question: {},
        runtime: {},
      },
      location: {},
    })

    const sdk = useSDK()
    const events = useEvent()
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: sdk.directory ?? process.cwd(),
    })

    const versions = new Map<string, Map<string, number>>()
    function changed(sessionID: string, ids: string[]) {
      const entries = versions.get(sessionID) ?? new Map<string, number>()
      for (const id of ids) entries.set(id, (entries.get(id) ?? 0) + 1)
      versions.set(sessionID, entries)
    }
    const history = createSessionMessageHistory({
      read: async (sessionID, query, signal) => {
        if (!store.session.message[sessionID]) setStore("session", "message", sessionID, [])
        const response = await sdk.client.v2.session.messages({ sessionID, ...query }, { throwOnError: true, signal })
        return response.data
      },
      list: (sessionID) => store.session.message[sessionID] ?? [],
      commit: (sessionID, messages, ids) =>
        batch(() => {
          changed(sessionID, ids)
          setStore("session", "message", sessionID, reconcile(messages, { key: "id" }))
          setStore("session", "messageRevision", sessionID, (value = 0) => value + 1)
        }),
    })
    onCleanup(history.dispose)

    const message = {
      update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
        setStore(
          "session",
          "message",
          produce((draft) => {
            fn((draft[sessionID] ??= []))
          }),
        )
        setStore("session", "messageRevision", sessionID, (value = 0) => value + 1)
      },
      prepend(messages: SessionMessage[], item: SessionMessage) {
        if (messages.some((existing) => existing.id === item.id)) return
        messages.unshift(item)
      },
      activeAssistant(messages: SessionMessage[]) {
        const item = messages.find((item) => item.type === "assistant" && !item.time.completed)
        return item?.type === "assistant" ? item : undefined
      },
      assistant(messages: SessionMessage[], messageID: string) {
        const item = messages.find((item) => item.type === "assistant" && item.id === messageID)
        return item?.type === "assistant" ? item : undefined
      },
      activeShell(messages: SessionMessage[], callID: string) {
        const item = messages.find((item) => item.type === "shell" && item.callID === callID)
        return item?.type === "shell" ? item : undefined
      },
      latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantTool =>
            item.type === "tool" && (callID === undefined || item.id === callID),
        )
      },
      latestText(assistant: SessionMessageAssistant | undefined, textID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
        )
      },
      latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
        )
      },
    }

    function handleRuntimeEvent(event: V2Event) {
      if ("sessionID" in event.data && typeof event.data.sessionID === "string" && event.durable) {
        const id = event.data.sessionID
        const current = store.session.runtime[id]
        const seq = event.durable.seq
        if (!current || seq > current.seq) {
          if (event.type === "session.turn.started") {
            setStore("session", "runtime", id, {
              turnID: event.data.turnID,
              terminal: false,
              seq,
              messageID: undefined,
              retry: undefined,
            })
          } else if (
            event.type === "session.turn.settled" ||
            event.type === "session.turn.not_started" ||
            event.type === "session.next.execution.reset"
          ) {
            setStore("session", "runtime", id, { ...current, terminal: true, seq, retry: undefined })
          } else if (
            event.type === "session.next.retried" &&
            current?.turnID === event.data.turnID &&
            !current.terminal
          ) {
            setStore("session", "runtime", id, { ...current, seq, retry: event.data })
          } else if (event.type === "session.next.step.started" && current && !current.terminal) {
            setStore("session", "runtime", id, {
              ...current,
              seq,
              messageID: event.data.assistantMessageID,
              retry: current.messageID === event.data.assistantMessageID ? current.retry : undefined,
            })
          } else if (event.type === "session.next.compaction.started" && current) {
            setStore("session", "runtime", id, { ...current, seq, retry: undefined })
          }
        }
      }
    }

    function handleEvent(event: V2Event) {
      if ("sessionID" in event.data && typeof event.data.sessionID === "string") {
        const sessionID = event.data.sessionID
        const id =
          "assistantMessageID" in event.data
            ? event.data.assistantMessageID
            : "messageID" in event.data
              ? event.data.messageID
              : event.type === "session.next.shell.ended"
                ? message.activeShell(store.session.message[sessionID] ?? [], event.data.callID)?.id
                : undefined
        if (typeof id === "string") {
          const part =
            "textID" in event.data
              ? event.data.textID
              : "reasoningID" in event.data
                ? event.data.reasoningID
                : "assistantMessageID" in event.data && "callID" in event.data
                  ? event.data.callID
                  : undefined
          history.touch(sessionID, id, typeof part === "string" ? part : undefined)
          changed(sessionID, [id])
        }
        if (event.type === "session.next.step.started") {
          const previous = message.activeAssistant(store.session.message[sessionID] ?? [])
          if (previous && previous.id !== event.data.assistantMessageID) {
            history.touch(sessionID, previous.id)
            changed(sessionID, [previous.id])
          }
        }
      }
      switch (event.type) {
        case "permission.v2.asked":
          setStore(
            "session",
            "permission",
            event.data.sessionID,
            produce((draft = []) => {
              const index = draft.findIndex((item) => item.id === event.data.id)
              if (index >= 0) draft[index] = event.data
              if (index < 0) draft.push(event.data)
            }),
          )
          break
        case "permission.v2.replied":
          setStore(
            "session",
            "permission",
            event.data.sessionID,
            produce((draft = []) => {
              const index = draft.findIndex((item) => item.id === event.data.requestID)
              if (index >= 0) draft.splice(index, 1)
            }),
          )
          break
        case "question.v2.asked":
          setStore(
            "session",
            "question",
            event.data.sessionID,
            produce((draft = []) => {
              const index = draft.findIndex((item) => item.id === event.data.id)
              if (index >= 0) draft[index] = event.data
              if (index < 0) draft.push(event.data)
            }),
          )
          break
        case "question.v2.replied":
        case "question.v2.rejected":
          setStore(
            "session",
            "question",
            event.data.sessionID,
            produce((draft = []) => {
              const index = draft.findIndex((item) => item.id === event.data.requestID)
              if (index >= 0) draft.splice(index, 1)
            }),
          )
          break
        case "session.next.agent.switched":
          break
        case "session.next.model.switched":
          if (store.session.info[event.data.sessionID]) {
            setStore(
              "session",
              "info",
              event.data.sessionID,
              produce((session) => {
                session.model = event.data.model
                session.time.updated = event.data.timestamp
              }),
            )
          }
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "model-switched",
              model: event.data.model,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.title.changed": {
          if (!store.session.info[event.data.sessionID]) break
          setStore("session", "info", event.data.sessionID, "title", event.data.title)
          setStore("session", "info", event.data.sessionID, "time", "updated", event.data.timestamp)
          break
        }
        case "session.next.prompted": {
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "user",
              text: event.data.prompt.text,
              files: event.data.prompt.files,
              agents: event.data.prompt.agents,
              time: { created: event.data.timestamp },
            })
          })
          break
        }
        case "session.next.prompt.admitted":
          break
        case "session.next.context.updated":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "system",
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.synthetic":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "synthetic",
              sessionID: event.data.sessionID,
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.started":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "shell",
              callID: event.data.callID,
              command: event.data.command,
              output: "",
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.activeShell(draft, event.data.callID)
            if (!match) return
            match.output = event.data.output
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.step.started":
          message.update(event.data.sessionID, (draft) => {
            if (draft.some((message) => message.id === event.data.assistantMessageID)) return
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) currentAssistant.time.completed = event.data.timestamp
            message.prepend(draft, {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = event.data.finish
            currentAssistant.cost = event.data.cost
            currentAssistant.tokens = event.data.tokens
            if (event.data.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.data.snapshot }
          })
          break
        case "session.next.step.failed":
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.data.error
          })
          break
        case "session.next.text.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "text",
              id: event.data.textID,
              text: "",
            })
          })
          break
        case "session.next.text.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.text.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text = event.data.text
          })
          break
        case "session.next.tool.input.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "tool",
              id: event.data.callID,
              name: event.data.name,
              time: { created: event.data.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input += event.data.delta
          })
          break
        case "session.next.tool.input.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input = event.data.text
          })
          break
        case "session.next.tool.called":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match) return
            match.time.ran = event.data.timestamp
            match.provider = event.data.provider
            match.state = { status: "running", input: event.data.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state.structured = event.data.structured
            match.state.content = [...event.data.content]
          })
          break
        case "session.next.tool.success":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.data.structured,
              content: [...event.data.content],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.tool.failed":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match || (match.state.status !== "pending" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.data.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.reasoning.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "reasoning",
              id: event.data.reasoningID,
              text: "",
              providerMetadata: event.data.providerMetadata,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.reasoning.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.reasoning.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) {
              match.text = event.data.text
              match.time = {
                created: match.time?.created ?? event.data.timestamp,
                completed: event.data.timestamp,
              }
              if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
            }
          })
          break
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          break
        case "session.next.compaction.ended":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "compaction",
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "reference.updated":
          void result.location.reference.refresh()
          break
      }
    }

    onMount(() => {
      const unsub = events.subscribe((event, metadata) => {
        batch(() =>
          handleEvent({
            ...event,
            data: event.properties,
            location: { directory: metadata.directory, workspaceID: metadata.workspace },
          } as V2Event),
        )
      })
      onCleanup(unsub)
      // OpenCode already forwards durable identity in its sync envelope. The
      // ordinary UI event envelope deliberately contains only properties.
      const unsubscribeRuntime = sdk.event.on("event", (envelope) => {
        if (envelope.payload.type !== "sync") return
        const event = envelope.payload.syncEvent
        const separator = event.type.lastIndexOf(".")
        const type = event.type.slice(0, separator)
        const version = Number(event.type.slice(separator + 1))
        if (type === "session.next.retried" && version !== 2) return
        const deadline =
          type === "session.next.retried" && "retryNotBefore" in event.data ? event.data.retryNotBefore : undefined
        const retryNotBefore =
          typeof deadline === "string" || typeof deadline === "number" || DateTime.isDateTime(deadline)
            ? Option.getOrUndefined(Option.map(DateTime.make(deadline), DateTime.toEpochMillis))
            : undefined
        handleRuntimeEvent({
          id: event.id,
          type,
          data: type === "session.next.retried" ? { ...event.data, retryNotBefore } : event.data,
          durable: { aggregateID: event.aggregateID, seq: event.seq, version },
        } as V2Event)
      })
      onCleanup(unsubscribeRuntime)
    })

    const result = {
      session: {
        turnID(sessionID: string) {
          const runtime = store.session.runtime[sessionID]
          return runtime?.terminal ? undefined : runtime?.turnID
        },
        retry(sessionID: string) {
          return store.session.runtime[sessionID]?.retry
        },
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        async refresh(sessionID: string) {
          const result = await sdk.client.v2.session.get({ sessionID }, { throwOnError: true })
          setStore("session", "info", sessionID, result.data.data)
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID]
          },
          revision(sessionID: string) {
            return store.session.messageRevision[sessionID] ?? 0
          },
          version(sessionID: string, messageID: string) {
            return versions.get(sessionID)?.get(messageID) ?? 0
          },
          history: history.state,
          loadOlder: history.loadOlder,
          refresh: history.refresh,
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true })
            setStore("session", "permission", sessionID, result.data.data)
          },
        },
        question: {
          list(sessionID: string) {
            return store.session.question[sessionID]
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true })
            setStore("session", "question", sessionID, result.data.data)
          },
        },
      },
      location: {
        default() {
          return defaultLocation()
        },
        async refresh(ref?: LocationRef) {
          const response = await sdk.client.v2.location.get({ location: locationQuery(ref) }, { throwOnError: true })
          const location = response.data
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.reference.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "reference", result.data.data)
          },
        },
      },
    }

    onMount(() => {
      void Promise.allSettled([result.location.refresh(), result.location.reference.refresh()]).then((settled) => {
        for (const failure of settled.filter((item) => item.status === "rejected"))
          console.error("Failed to refresh default location data", failure.reason)
      })
    })

    return result
  },
})
