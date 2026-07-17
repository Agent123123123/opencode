import { AgentV2 } from "@opencode-ai/core/agent"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { DateTime } from "effect"

export function systemContextRequest(directory = AbsolutePath.make("/project")): SystemContextRegistry.Request {
  const now = DateTime.makeUnsafe(0)
  return {
    session: new SessionSchema.Info({
      id: SessionSchema.ID.make("ses_system_context_fixture"),
      projectID: ProjectV2.ID.make("project-system-context-fixture"),
      agent: AgentV2.ID.make("build"),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
      title: "System context fixture",
      location: { directory },
    }),
    agent: { id: AgentV2.ID.make("build"), info: undefined },
    activityInputIDs: [],
  }
}
