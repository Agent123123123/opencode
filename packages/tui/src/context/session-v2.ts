import type { PromptInput, SessionMessage } from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../prompt/history"

export function v2PromptInput(text: string, parts: PromptInfo["parts"]): PromptInput {
  const files = parts.flatMap((part) => {
    if (part.type !== "file") return []
    const source = part.source
      ? { start: part.source.text.start, end: part.source.text.end, text: part.source.text.value }
      : undefined
    return [
      {
        uri: part.url,
        name: part.filename,
        description: fileDescription(part.source),
        source,
      },
    ]
  })
  const agents = parts.flatMap((part) => {
    if (part.type !== "agent") return []
    return [
      {
        name: part.name,
        source: part.source ? { start: part.source.start, end: part.source.end, text: part.source.value } : undefined,
      },
    ]
  })
  return {
    text,
    files: files.length > 0 ? files : undefined,
    agents: agents.length > 0 ? agents : undefined,
  }
}

export function v2TurnHasTerminalAssistant(messages: SessionMessage[], inputID: string) {
  const input = messages.find((message) => message.type === "user" && message.id === inputID)
  if (!input) return false
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      message.time.created >= input.time.created &&
      message.time.completed !== undefined &&
      message.finish !== undefined &&
      message.finish !== "tool-calls",
  )
}

function fileDescription(source: Extract<PromptInfo["parts"][number], { type: "file" }>["source"]) {
  if (!source) return undefined
  if (source.type === "resource") return `${source.clientName}:${source.uri}`
  return source.path
}
