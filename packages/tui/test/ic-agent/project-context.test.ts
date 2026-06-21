import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveMotryxProjectContext } from "../../src/ic-agent/project-context"

test("resolves Motryx project context from selected orchestrator binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-project-context-"))
  try {
    const project = path.join(root, "project")
    const dataRoot = path.join(project, ".motryx", "db")
    const channelDb = path.join(dataRoot, "channel.db")
    const icAgentDb = path.join(dataRoot, "orchestrators", "ses_orch", "ic-agent.db")
    mkdirSync(path.dirname(channelDb), { recursive: true })
    mkdirSync(path.dirname(icAgentDb), { recursive: true })
    const db = new Database(channelDb)
    try {
      db.exec(`
        create table orchestrator_bindings (
          project_id text not null,
          orchestrator_session_id text not null,
          ic_agent_db_path text not null,
          schema_version integer not null,
          created_at text not null,
          updated_at text not null,
          primary key (project_id, orchestrator_session_id)
        );
      `)
      db.query("insert into orchestrator_bindings values (?, ?, ?, 1, 'now', 'now')").run(project, "ses_orch", icAgentDb)
    } finally {
      db.close()
    }

    const context = resolveMotryxProjectContext({
      projectDir: project,
      selectedSessionID: "ses_orch",
      env: {
        OPENCODE_DB: "motryx.db",
        XDG_DATA_HOME: dataRoot,
      },
    })

    expect(context).toMatchObject({
      product: "Motryx",
      projectDir: project,
      dataRoot,
      channelDbPath: channelDb,
      motryxSessionDbPath: path.join(dataRoot, "opencode", "motryx.db"),
      currentOrchestratorSessionID: "ses_orch",
      currentIcAgentDbPath: icAgentDb,
      bindingStatus: "bound",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("keeps explicit orchestrator context when the selected conversation is an internal agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-project-context-"))
  try {
    const project = path.join(root, "project")
    const dataRoot = path.join(project, ".motryx", "db")
    const channelDb = path.join(dataRoot, "channel.db")
    const icAgentDb = path.join(dataRoot, "orchestrators", "ses_orch", "ic-agent.db")
    mkdirSync(path.dirname(channelDb), { recursive: true })
    mkdirSync(path.dirname(icAgentDb), { recursive: true })
    const db = new Database(channelDb)
    try {
      db.exec(`
        create table orchestrator_bindings (
          project_id text not null,
          orchestrator_session_id text not null,
          ic_agent_db_path text not null,
          schema_version integer not null,
          created_at text not null,
          updated_at text not null,
          primary key (project_id, orchestrator_session_id)
        );
      `)
      db.query("insert into orchestrator_bindings values (?, ?, ?, 1, 'now', 'now')").run(project, "ses_orch", icAgentDb)
    } finally {
      db.close()
    }

    const context = resolveMotryxProjectContext({
      projectDir: project,
      orchestratorSessionID: "ses_orch",
      selectedSessionID: "ses_coord",
      env: {
        OPENCODE_DB: "motryx.db",
        XDG_DATA_HOME: dataRoot,
      },
    })

    expect(context.currentOrchestratorSessionID).toBe("ses_orch")
    expect(context.currentIcAgentDbPath).toBe(icAgentDb)
    expect(context.bindingStatus).toBe("bound")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports missing binding without falling back to unrelated session state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-project-context-"))
  try {
    const project = path.join(root, "project")
    mkdirSync(project, { recursive: true })

    const context = resolveMotryxProjectContext({
      projectDir: project,
      selectedSessionID: "ses_missing",
      env: {
        OPENCODE_DB: "motryx.db",
      },
    })

    expect(context.currentOrchestratorSessionID).toBe("ses_missing")
    expect(context.currentIcAgentDbPath).toBeUndefined()
    expect(context.bindingStatus).toBe("missing-binding")
    expect(context.channelDbPath).toBe(path.join(project, ".motryx", "db", "channel.db"))
    expect(context.motryxSessionDbPath).toBe(path.join(project, ".motryx", "db", "opencode", "motryx.db"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
