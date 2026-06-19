import { expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import {
  createMotryxOrchestratorSessionID,
  ensureMotryxOrchestratorBinding,
  motryxBindingExists,
  resolveMotryxRuntimePaths,
} from "../../src/ic-agent/orchestrator-binding"

test("creates OpenCode-compatible Motryx orchestrator session ids", () => {
  const id = createMotryxOrchestratorSessionID()

  expect(id).toStartWith("ses_")
})

test("creates and reuses a project-local Motryx orchestrator binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-binding-"))
  try {
    const project = path.join(root, "project")
    mkdirSync(project, { recursive: true })
    const env: Record<string, string | undefined> = {}

    const binding = ensureMotryxOrchestratorBinding({
      projectDir: project,
      sessionID: "ses/new:1",
      env,
    })

    expect(binding.projectID).toBe(project)
    expect(binding.orchestratorSessionID).toBe("ses/new:1")
    expect(binding.icAgentDbPath).toBe(path.join(project, ".motryx", "db", "orchestrators", "ses_new_1", "ic-agent.db"))
    expect(env.MOTRYX_ORCHESTRATOR_SESSION_ID).toBe("ses/new:1")
    expect(env.MOTRYX_IC_AGENT_DB_PATH).toBe(binding.icAgentDbPath)
    expect(env.IC_AGENT_DB_PATH).toBe(binding.icAgentDbPath)
    expect(env.MOTRYX_CHANNEL_DB).toBe(path.join(project, ".motryx", "db", "channel.db"))
    expect(motryxBindingExists({ projectDir: project, sessionID: "ses/new:1", env })).toBe(true)

    const reused = ensureMotryxOrchestratorBinding({
      projectDir: project,
      sessionID: "ses/new:1",
      env,
    })

    expect(reused.icAgentDbPath).toBe(binding.icAgentDbPath)
    const db = new Database(env.MOTRYX_CHANNEL_DB!, { readonly: true })
    try {
      const count = db.query<{ count: number }, []>("select count(*) as count from orchestrator_bindings").get()?.count
      expect(count).toBe(1)
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("honors explicit Motryx runtime roots from the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-binding-"))
  try {
    const project = path.join(root, "project")
    const dataRoot = path.join(root, "external-data")
    const channelDb = path.join(root, "channel", "channel.db")
    mkdirSync(project, { recursive: true })
    const env: Record<string, string | undefined> = {
      MOTRYX_DATA_ROOT: dataRoot,
      MOTRYX_CHANNEL_DB: channelDb,
    }

    const paths = resolveMotryxRuntimePaths({ projectDir: project, env })
    const binding = ensureMotryxOrchestratorBinding({
      projectDir: project,
      sessionID: "ses_ext",
      env,
    })

    expect(paths.dataRoot).toBe(dataRoot)
    expect(paths.channelDb).toBe(channelDb)
    expect(binding.icAgentDbPath).toBe(path.join(dataRoot, "orchestrators", "ses_ext", "ic-agent.db"))
    expect(env.MOTRYX_CHANNEL_DB).toBe(channelDb)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
