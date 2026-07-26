import { expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { projectSessionMessagesToLegacy } from "../src/context/session-message-projection"

test("projects durable V2 conversation messages into the original Session surface model", () => {
  const input: SessionMessage[] = [
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "orchestrator",
      model: { providerID: "zai-coding-plan", id: "glm-5.1", variant: "default" },
      time: { created: 20, completed: 40 },
      finish: "stop",
      cost: 0,
      tokens: { input: 3, output: 4, reasoning: 5, cache: { read: 6, write: 0 } },
      content: [
        { id: "reasoning-0", type: "reasoning", text: "check the lane", time: { created: 21, completed: 22 } },
        {
          id: "call-0",
          type: "tool",
          name: "status_get",
          time: { created: 23, ran: 24, completed: 25 },
          state: {
            status: "completed",
            input: { mode: "read_only" },
            content: [{ type: "text", text: "lane working" }],
            structured: { title: "Status", output: "lane working", metadata: { source: "control" } },
          },
        },
        { id: "text-0", type: "text", text: "Lane is healthy." },
      ],
    },
    {
      id: "msg_user",
      type: "user",
      text: "Inspect the workflow",
      time: { created: 10 },
    },
  ]

  const result = projectSessionMessagesToLegacy("ses_orchestrator", input, {
    agent: "orchestrator",
    model: { providerID: "zai-coding-plan", id: "glm-5.1", variant: "default" },
    directory: "/tmp/project",
  })

  expect(result.messages.map((item) => item.id)).toEqual(["msg_user", "msg_assistant"])
  expect(result.messages[0]).toMatchObject({ role: "user", agent: "orchestrator" })
  expect(result.messages[1]).toMatchObject({
    role: "assistant",
    parentID: "msg_user",
    providerID: "zai-coding-plan",
    modelID: "glm-5.1",
    finish: "stop",
  })
  expect(result.parts.msg_user).toMatchObject([{ type: "text", text: "Inspect the workflow" }])
  expect(result.parts.msg_assistant).toMatchObject([
    { type: "reasoning", text: "check the lane" },
    {
      type: "tool",
      tool: "status_get",
      state: { status: "completed", title: "Status", output: "lane working" },
    },
    { type: "text", text: "Lane is healthy." },
  ])
})

test("does not expose V2 system projections as user conversation turns", () => {
  const result = projectSessionMessagesToLegacy(
    "ses_orchestrator",
    [
      { id: "msg_system", type: "system", text: "hidden context", time: { created: 1 } },
      {
        id: "msg_shell",
        type: "shell",
        callID: "shell-1",
        command: "pwd",
        output: "/tmp/project",
        time: { created: 2, completed: 3 },
      },
    ],
    { directory: "/tmp/project" },
  )

  expect(result.messages).toHaveLength(1)
  expect(result.messages[0]).toMatchObject({ id: "msg_shell", role: "assistant" })
  expect(result.parts.msg_shell).toMatchObject([{ type: "text", text: "$ pwd\n/tmp/project" }])
})
