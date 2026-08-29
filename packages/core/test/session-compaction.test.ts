import { expect, test } from "bun:test"
import { Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionModelContext } from "@opencode-ai/core/session/model-context"
import { DateTime, Effect } from "effect"

const created = DateTime.makeUnsafe(0)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction excludes failed narrative but retains terminal tool facts", () => {
  const projection = Effect.runSync(
    SessionModelContext.projectEntries(
      [
        {
          seq: 1,
          message: SessionMessage.Assistant.make({
            id: SessionMessage.ID.make("msg_failed_tool"),
            type: "assistant",
            agent: "build",
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
            content: [
              SessionMessage.AssistantReasoning.make({
                id: "reasoning_failed",
                type: "reasoning",
                text: "reasoning must not reach compaction",
              }),
              SessionMessage.AssistantTool.make({
                id: "read_complete",
                type: "tool",
                name: "read",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: { path: "README.md" },
                  content: [{ type: "text", text: "durable tool result" }],
                  structured: {},
                }),
                time: { created, completed: created },
              }),
            ],
            finish: "error",
            error: { type: "unknown", message: "transport failed" },
            time: { created, completed: created },
          }),
        },
      ],
      model,
    ),
  )

  expect(projection.messages.map((message) => message.role)).toEqual(["assistant", "tool"])
  expect(projection.messages[0]).toMatchObject(
    Message.assistant({ type: "tool-call", id: "read_complete", name: "read", input: { path: "README.md" } }),
  )
  const serialized = SessionCompaction.serializeProjectedEntry(projection.entries[0]!)
  expect(serialized).toContain('[Assistant tool call]: read({"path":"README.md"})')
  expect(serialized).toContain("[Tool result]: durable tool result")
  expect(serialized).toContain("durable tool result")
  expect(serialized).not.toContain("reasoning must not reach compaction")
})

test("compaction excludes length-exhausted reasoning-only narrative", () => {
  const marker = "LENGTH_REASONING_MUST_NOT_REACH_COMPACTION"
  const projection = Effect.runSync(
    SessionModelContext.projectEntries(
      [
        {
          seq: 1,
          message: SessionMessage.Assistant.make({
            id: SessionMessage.ID.make("msg_length_reasoning"),
            type: "assistant",
            agent: "build",
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
            content: [
              SessionMessage.AssistantReasoning.make({
                id: "reasoning_length",
                type: "reasoning",
                text: marker,
              }),
            ],
            finish: "length",
            time: { created, completed: created },
          }),
        },
      ],
      model,
    ),
  )

  expect(projection.messages).toEqual([])
  const context = projection.entries.map(SessionCompaction.serializeProjectedEntry).filter(Boolean)
  expect(context).toEqual([])
  expect(SessionCompaction.buildPrompt({ context })).not.toContain(marker)
  expect(JSON.stringify(projection)).not.toContain(marker)
})
