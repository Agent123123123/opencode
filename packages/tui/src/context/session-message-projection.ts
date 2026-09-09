import type {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message,
  Part,
  PermissionRequest,
  PermissionV2Request,
  QuestionRequest,
  QuestionV2Request,
  Session,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionV2Info,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"

export type SessionMessageProjectionFallback = {
  agent?: string
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  directory: string
}

export type ProjectedLegacyMessages = {
  messages: Message[]
  parts: Record<string, Part[]>
}

const INTERNAL_MOTRYX_INPUT = /^\s*<ic_agent_wakeup>/i

export function projectSessionInfoToLegacy(input: SessionV2Info): Session {
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID,
    workspaceID: input.location.workspaceID,
    directory: input.location.directory,
    path: input.subpath,
    parentID: input.parentID,
    cost: input.cost,
    tokens: input.tokens,
    title: input.title,
    agent: input.agent,
    model: input.model,
    version: "v2",
    metadata: { executionManaged: input.execution.managed },
    time: input.time,
    revert: input.revert,
  }
}

export function projectPermissionRequestToLegacy(input: PermissionV2Request): PermissionRequest {
  return {
    id: input.id,
    sessionID: input.sessionID,
    permission: input.action,
    patterns: input.resources,
    metadata: input.metadata ?? {},
    always: input.save ?? [],
    tool:
      input.source?.type === "tool" ? { messageID: input.source.messageID, callID: input.source.callID } : undefined,
  }
}

export function projectQuestionRequestToLegacy(input: QuestionV2Request): QuestionRequest {
  return {
    id: input.id,
    sessionID: input.sessionID,
    questions: input.questions,
    tool: input.tool,
  }
}

/**
 * The pinned host persists its durable conversation in the V2 session-message
 * projection. The existing OpenCode Session surface still renders the legacy
 * Message/Part view, so keep that UI and adapt the API projection at the TUI
 * boundary. This does not invent domain state or read storage directly.
 */
export type SessionMessageProjectionCache = Map<
  string,
  {
    revision: number
    parentID?: string
    fallback: string
    value: ProjectedLegacyMessages
  }
>

export function projectSessionMessagesToLegacy(
  sessionID: string,
  input: SessionMessage[],
  fallback: SessionMessageProjectionFallback,
  cache?: SessionMessageProjectionCache,
  revision: (id: string) => number = () => 0,
): ProjectedLegacyMessages & { changed: Set<string> } {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}
  const changed = new Set<string>()
  const key = JSON.stringify(fallback)
  let parentID: string | undefined
  // V2 pages and the live cache are newest first, in Host order.
  for (const item of input.toReversed()) {
    const previous = cache?.get(item.id)
    const version = revision(item.id)
    const value =
      previous && previous.revision === version && previous.parentID === parentID && previous.fallback === key
        ? previous.value
        : projectMessage(sessionID, item, parentID, fallback)
    if (value !== previous?.value) {
      changed.add(item.id)
      cache?.set(item.id, { revision: version, parentID, fallback: key, value })
    }
    messages.push(...value.messages)
    Object.assign(parts, value.parts)
    if (item.type === "user") parentID = item.id
  }
  return { messages, parts, changed }
}

function projectMessage(
  sessionID: string,
  item: SessionMessage,
  parentID: string | undefined,
  fallback: SessionMessageProjectionFallback,
): ProjectedLegacyMessages {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}
  if (item.type === "user") {
    const synthetic = INTERNAL_MOTRYX_INPUT.test(item.text)
    const info: UserMessage = {
      id: item.id,
      sessionID,
      role: "user",
      time: { created: item.time.created },
      agent: fallback.agent ?? "orchestrator",
      model: {
        providerID: fallback.model?.providerID ?? "unknown",
        modelID: fallback.model?.id ?? "unknown",
        variant: fallback.model?.variant,
      },
    }
    messages.push(info)
    parts[item.id] = [
      {
        id: `${item.id}:text`,
        sessionID,
        messageID: item.id,
        type: "text",
        text: item.text,
        synthetic,
      },
      ...(item.files ?? []).map(
        (file, index): FilePart => ({
          id: `${item.id}:file:${index}`,
          sessionID,
          messageID: item.id,
          type: "file",
          mime: file.mime,
          filename: file.name,
          url: file.uri,
        }),
      ),
      ...(item.agents ?? []).map(
        (agent, index): AgentPart => ({
          id: `${item.id}:agent:${index}`,
          sessionID,
          messageID: item.id,
          type: "agent",
          name: agent.name,
          source: agent.source
            ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
            : undefined,
        }),
      ),
    ]
    return { messages, parts }
  }

  if (item.type === "assistant") {
    const info = assistantInfo(sessionID, item, parentID, fallback)
    messages.push(info)
    parts[item.id] = item.content.map((content): Part => {
      const id = `${item.id}:${content.id}`
      if (content.type === "text") {
        return { id, sessionID, messageID: item.id, type: "text", text: content.text }
      }
      if (content.type === "reasoning") {
        return {
          id,
          sessionID,
          messageID: item.id,
          type: "reasoning",
          text: content.text,
          metadata: content.providerMetadata,
          time: {
            start: content.time?.created ?? item.time.created,
            end: content.time?.completed,
          },
        }
      }
      return toolPart(sessionID, item.id, id, content)
    })
    return { messages, parts }
  }

  if (item.type === "shell") {
    const info: AssistantMessage = {
      id: item.id,
      sessionID,
      role: "assistant",
      time: item.time,
      parentID: parentID ?? item.id,
      modelID: fallback.model?.id ?? "shell",
      providerID: fallback.model?.providerID ?? "local",
      mode: fallback.agent ?? "orchestrator",
      agent: fallback.agent ?? "orchestrator",
      path: { cwd: fallback.directory, root: fallback.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: item.time.completed ? "stop" : undefined,
    }
    messages.push(info)
    parts[item.id] = [
      {
        id: `${item.id}:shell`,
        sessionID,
        messageID: item.id,
        type: "text",
        text: `$ ${item.command}\n${item.output}`.trimEnd(),
      },
    ]
  }
  return { messages, parts }
}

function assistantInfo(
  sessionID: string,
  item: SessionMessageAssistant,
  parentID: string | undefined,
  fallback: SessionMessageProjectionFallback,
): AssistantMessage {
  return {
    id: item.id,
    sessionID,
    role: "assistant",
    time: item.time,
    parentID: parentID ?? item.id,
    modelID: item.model.id,
    providerID: item.model.providerID,
    variant: item.model.variant,
    mode: item.agent,
    agent: item.agent,
    path: { cwd: fallback.directory, root: fallback.directory },
    cost: item.cost ?? 0,
    tokens: item.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: item.finish,
    error: item.error
      ? {
          name: "UnknownError",
          data: { message: errorText(item.error) },
        }
      : undefined,
  }
}

function toolPart(sessionID: string, messageID: string, id: string, item: SessionMessageAssistantTool): ToolPart {
  const structured = record(item.state.status === "pending" ? undefined : item.state.structured)
  const input = item.state.status === "pending" ? parseInput(item.state.input) : item.state.input
  const start = item.time.ran ?? item.time.created

  if (item.state.status === "pending") {
    return {
      id,
      sessionID,
      messageID,
      type: "tool",
      callID: item.id,
      tool: item.name,
      state: { status: "pending", input, raw: item.state.input },
    }
  }
  if (item.state.status === "running") {
    return {
      id,
      sessionID,
      messageID,
      type: "tool",
      callID: item.id,
      tool: item.name,
      state: {
        status: "running",
        input,
        title: stringValue(structured.title),
        metadata: record(structured.metadata),
        time: { start },
      },
    }
  }
  if (item.state.status === "error") {
    return {
      id,
      sessionID,
      messageID,
      type: "tool",
      callID: item.id,
      tool: item.name,
      state: {
        status: "error",
        input,
        error: errorText(item.state.error),
        metadata: record(structured.metadata),
        time: { start, end: item.time.completed ?? start },
      },
    }
  }
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: item.id,
    tool: item.name,
    state: {
      status: "completed",
      input,
      output: stringValue(structured.output) ?? contentText(item.state.content),
      title: stringValue(structured.title) ?? item.name,
      metadata: record(structured.metadata),
      time: { start, end: item.time.completed ?? start },
    },
  }
}

function parseInput(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return record(parsed)
  } catch {
    return {}
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}

function contentText(value: unknown[]) {
  return value
    .map((item) => {
      const data = record(item)
      if (typeof data.text === "string") return data.text
      try {
        return JSON.stringify(item)
      } catch {
        return String(item)
      }
    })
    .filter(Boolean)
    .join("\n")
}

function errorText(value: unknown) {
  if (value instanceof Error) return value.message
  const data = record(value)
  if (typeof data.message === "string") return data.message
  const nested = record(data.data)
  if (typeof nested.message === "string") return nested.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
