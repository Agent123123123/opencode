import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect } from "effect"

export const toolIdentity = {
  agent: AgentV2.ID.make("build"),
  turnID: SessionMessage.ID.make("msg_turn_tool_test"),
  assistantMessageID: SessionMessage.ID.make("msg_tool_test"),
}

type ToolInput = Omit<ToolRegistry.ExecuteInput, "turnID"> & Partial<Pick<ToolRegistry.ExecuteInput, "turnID">>

const withTurn = (input: ToolInput): ToolRegistry.ExecuteInput => ({
  turnID: toolIdentity.turnID,
  ...input,
})

export const toolDefinitions = (
  registry: ToolRegistry.Interface,
  permissions?: Parameters<typeof registry.materialize>[0],
) => registry.materialize(permissions).pipe(Effect.map((materialized) => materialized.definitions))

export const settleTool = (registry: ToolRegistry.Interface, input: ToolInput) =>
  registry.materialize().pipe(Effect.flatMap((materialized) => materialized.settle(withTurn(input))))

export const executeTool = (registry: ToolRegistry.Interface, input: ToolInput) =>
  settleTool(registry, input).pipe(Effect.map((settlement) => settlement.result))
