import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readMotryxSessionHistory } from "../../src/ic-agent/session-history"
import { REQUIRED_IC_AGENT_MIGRATION } from "../../src/ic-agent/schema-contract"

test("reads project-scoped orchestrator session history from Motryx DB", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "motryx.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(project, { recursive: true })
    seedSessionDb(dbPath, project)

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
      },
    })

    expect(history.status).toBe("ok")
    expect(history.dbPath).toBe(dbPath)
    expect(history.sessions).toEqual([{
      handle: "@1",
      id: "ses_orch",
      title: "Top orchestrator",
      agent: "orchestrator",
      created: Date.UTC(2026, 5, 16, 8, 30, 0),
      createdText: `started ${localTimeLabel(Date.UTC(2026, 5, 16, 8, 30, 0))}`,
      updated: Date.UTC(2026, 5, 16, 9, 0, 0),
      updatedText: `updated ${localTimeLabel(Date.UTC(2026, 5, 16, 9, 0, 0))}`,
      messageCount: 2,
      bindingStatus: "missing-ic-db",
    }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("cleans default UTC session titles and exposes local started and updated labels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "motryx.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(project, { recursive: true })
    seedSessionDb(dbPath, project)
    const db = new Database(dbPath)
    try {
      db.query("update session set title = ?, time_created = ?, time_updated = ? where id = ?").run(
        "New session - 2026-07-07T00:34:53.900Z",
        Date.UTC(2026, 6, 7, 0, 34, 53, 900),
        Date.UTC(2026, 6, 7, 1, 16, 24),
        "ses_orch",
      )
    } finally {
      db.close()
    }

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
      },
    })

    expect(history.sessions[0]).toMatchObject({
      id: "ses_orch",
      title: "Untitled orchestrator",
      createdText: `started ${localTimeLabel(Date.UTC(2026, 6, 7, 0, 34, 53, 900))}`,
      updatedText: `updated ${localTimeLabel(Date.UTC(2026, 6, 7, 1, 16, 24))}`,
    })
    expect(history.sessions[0]?.title).not.toContain("2026-07-07T00:34:53.900Z")
    expect(history.sessions[0]?.updatedText).not.toContain("T")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("annotates orchestrator sessions with Motryx binding status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "motryx.db")
    const channelDb = path.join(dataHome, "channel.db")
    const icAgentDbPath = path.join(dataHome, "orchestrators", "ses_orch", "ic-agent.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(path.dirname(channelDb), { recursive: true })
    mkdirSync(project, { recursive: true })
    seedSessionDb(dbPath, project)
    seedWorkflowDb(icAgentDbPath)
    seedBindingDb(channelDb, project, "ses_orch", icAgentDbPath)

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
        MOTRYX_CHANNEL_DB: channelDb,
      },
    })

    expect(history.status).toBe("ok")
    expect(history.sessions[0]).toMatchObject({
      id: "ses_orch",
      bindingStatus: "bound",
      icAgentDbPath,
      workflowSummary: {
        status: "ok",
        workflowID: "wf_1",
        workflowStatus: "RUNNING",
        lanes: 3,
        active: 1,
        blocked: 1,
        checking: 0,
        done: 1,
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports missing ic-agent db when binding path is stale", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "motryx.db")
    const channelDb = path.join(dataHome, "channel.db")
    const icAgentDbPath = path.join(dataHome, "orchestrators", "ses_orch", "ic-agent.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(path.dirname(channelDb), { recursive: true })
    mkdirSync(project, { recursive: true })
    seedSessionDb(dbPath, project)
    seedBindingDb(channelDb, project, "ses_orch", icAgentDbPath)

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
        MOTRYX_CHANNEL_DB: channelDb,
      },
    })

    expect(history.sessions[0]).toMatchObject({
      id: "ses_orch",
      bindingStatus: "missing-ic-db",
      icAgentDbPath,
      workflowSummary: {
        status: "missing-db",
        lanes: 0,
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports stale schema when a bound ic-agent db needs migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "motryx.db")
    const channelDb = path.join(dataHome, "channel.db")
    const icAgentDbPath = path.join(dataHome, "orchestrators", "ses_orch", "ic-agent.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(path.dirname(channelDb), { recursive: true })
    mkdirSync(project, { recursive: true })
    seedSessionDb(dbPath, project)
    seedWorkflowDb(icAgentDbPath, { latestSchema: false })
    seedBindingDb(channelDb, project, "ses_orch", icAgentDbPath)

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
        MOTRYX_CHANNEL_DB: channelDb,
      },
    })

    expect(history.sessions[0]).toMatchObject({
      id: "ses_orch",
      bindingStatus: "stale-schema",
      requiredMigration: REQUIRED_IC_AGENT_MIGRATION,
      icAgentDbPath,
      workflowSummary: {
        status: "ok",
        lanes: 3,
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("falls back to legacy dogfood DB only when canonical Motryx DB is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "opencode-local.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(project, { recursive: true })
    seedSessionDb(dbPath, project)

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
      },
    })

    expect(history.status).toBe("ok")
    expect(history.dbPath).toBe(dbPath)
    expect(history.sessions.map((session) => session.id)).toEqual(["ses_orch"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports missing DB without throwing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    mkdirSync(project, { recursive: true })

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
      },
    })

    expect(history).toMatchObject({
      status: "missing_db",
      projectDir: project,
      sessions: [],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports unreadable DB as an error state for picker fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-session-history-"))
  try {
    const project = path.join(root, "project")
    const dataHome = path.join(root, "home", "data")
    const dbPath = path.join(dataHome, "opencode", "motryx.db")
    mkdirSync(path.dirname(dbPath), { recursive: true })
    mkdirSync(project, { recursive: true })
    writeFileSync(dbPath, "not sqlite")

    const history = await readMotryxSessionHistory({
      projectDir: project,
      env: {
        XDG_DATA_HOME: dataHome,
        OPENCODE_DB: "motryx.db",
      },
    })

    expect(history.status).toBe("error")
    expect(history.dbPath).toBe(dbPath)
    expect(history.sessions).toEqual([])
    expect(history.error).toBeTruthy()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function seedSessionDb(dbPath: string, project: string) {
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        agent TEXT,
        directory TEXT,
        parent_id TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER
      );
    `)
    const insert = db.query(`
      INSERT INTO session (id, title, agent, directory, parent_id, time_created, time_updated)
      VALUES ($id, $title, $agent, $directory, $parent, $created, $time)
    `)
    insert.run({
      $id: "ses_checker",
      $title: "checker internal",
      $agent: "checker",
      $directory: project,
      $parent: null,
      $created: Date.UTC(2026, 5, 16, 9, 30, 0),
      $time: Date.UTC(2026, 5, 16, 10, 0, 0),
    })
    insert.run({
      $id: "ses_orch",
      $title: "Top orchestrator",
      $agent: "orchestrator",
      $directory: project,
      $parent: null,
      $created: Date.UTC(2026, 5, 16, 8, 30, 0),
      $time: Date.UTC(2026, 5, 16, 9, 0, 0),
    })
    insert.run({
      $id: "ses_other",
      $title: "Other orchestrator",
      $agent: "orchestrator",
      $directory: `${project}-other`,
      $parent: null,
      $created: Date.UTC(2026, 5, 16, 10, 30, 0),
      $time: Date.UTC(2026, 5, 16, 11, 0, 0),
    })
    const insertMessage = db.query(`
      INSERT INTO message (id, session_id, time_created)
      VALUES ($id, $session, $time)
    `)
    insertMessage.run({ $id: "msg_1", $session: "ses_orch", $time: 1 })
    insertMessage.run({ $id: "msg_2", $session: "ses_orch", $time: 2 })
  } finally {
    db.close()
  }
}

function localTimeLabel(value: number) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  const hour = `${date.getHours()}`.padStart(2, "0")
  const minute = `${date.getMinutes()}`.padStart(2, "0")
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function seedBindingDb(dbPath: string, project: string, sessionID: string, icAgentDbPath: string) {
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE orchestrator_bindings (
        project_id TEXT NOT NULL,
        orchestrator_session_id TEXT NOT NULL,
        ic_agent_db_path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, orchestrator_session_id)
      );
    `)
    db.query("INSERT INTO orchestrator_bindings VALUES (?, ?, ?, 1, 'now', 'now')").run(project, sessionID, icAgentDbPath)
  } finally {
    db.close()
  }
}

function seedWorkflowDb(dbPath: string, options: { latestSchema?: boolean } = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY
      );
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        status TEXT,
        goal TEXT
      );
      CREATE TABLE lanes (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT
      );
      INSERT INTO workflows VALUES ('wf_1', 'RUNNING', 'finish product integration');
      INSERT INTO lanes VALUES ('lane_1', 'frontend', 'WORKING');
      INSERT INTO lanes VALUES ('lane_2', 'backend', 'BLOCKED');
      INSERT INTO lanes VALUES ('lane_3', 'release', 'DONE');
    `)
    db.query("INSERT INTO schema_migrations VALUES (?)").run(
      options.latestSchema === false ? "v2_0018_waiver_audit" : REQUIRED_IC_AGENT_MIGRATION,
    )
  } finally {
    db.close()
  }
}
