import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveMotryxProjectContext } from "../../src/ic-agent/project-context"
import { readIcWorkflowSnapshot } from "../../src/ic-agent/workflow-adapter"

const REQUIRED_IC_AGENT_MIGRATION = "v2_0019_agent_orchestrator_binding"

test("reads IC workflow state from a local state.db fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const stateDir = path.join(project, ".ic-agent")
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(path.join(project, "docs"), { recursive: true })
    mkdirSync(path.join(project, "dv", "reports"), { recursive: true })
    writeFileSync(path.join(project, "docs", "coverage.md"), "# Coverage\n")
    writeFileSync(path.join(project, "docs", "compile.log"), "compile ok\n")
    writeFileSync(path.join(project, "dv", "reports", "coverage.html"), "<html></html>\n")

    const stateDb = path.join(stateDir, "state.db")
    const db = new Database(stateDb)
    try {
      db.exec(`
        create table schema_migrations (
          version text primary key
        );
        create table workflows (
          id text,
          status text,
          goal text
        );
        create table lanes (
          id text,
          name text,
          status text,
          updated_at text,
          last_check_result text,
          pending_check_summary text,
          reopen_count integer,
          repair_cycle integer,
          depends_on_lane_ids_json text
        );
        create table agent_instances (
          instance_id text,
          role text,
          session_id text,
          orchestrator_session_id text,
          status text
        );
        create table lane_assignments (
          lane_id text,
          instance_id text,
          role text,
          status text
        );
        create table transactional_outbox (
          status text
        );
        create table messages (
          delivery_status text
        );
        create table wake_queue (
          status text
        );

        insert into workflows values ('wf_1', 'active', 'close coverage');
        insert into lanes values (
          'lane_1',
          'coverage',
          'CHECKING',
          '2026-06-14T01:02:03.000Z',
          'REWORK',
          'waiting on coverage evidence',
          1,
          2,
          '[]'
        );
        insert into agent_instances values ('inst_coord', 'coordinator', 'ses_coord', 'ses_orch', 'ALIVE');
        insert into agent_instances values ('inst_checker', 'checker', 'ses_checker', 'ses_orch', 'BUSY');
        insert into lane_assignments values ('lane_1', 'inst_coord', 'coordinator', 'ACTIVE');
        insert into lane_assignments values ('lane_1', 'inst_checker', 'checker', 'ACTIVE');
        insert into lane_assignments values ('lane_ignored', 'inst_checker', 'checker', 'DONE');
        insert into transactional_outbox values ('FAILED');
        insert into transactional_outbox values ('DEAD_LETTER');
        insert into messages values ('PENDING_DELIVERY');
        insert into wake_queue values ('PENDING');
      `)
      db.query("insert into schema_migrations values (?)").run(REQUIRED_IC_AGENT_MIGRATION)
    } finally {
      db.close()
    }

    const snapshot = await readIcWorkflowSnapshot(project)

    expect(snapshot.stateDb).toBe(stateDb)
    expect(snapshot.stateDbSource).toMatchObject({
      kind: "legacy-project-state",
      legacy: true,
      productTruth: false,
    })
    expect(snapshot.workflow).toEqual({
      id: "wf_1",
      status: "active",
      goal: "close coverage",
    })
    expect(snapshot.lanes).toEqual([{
      id: "lane_1",
      name: "coverage",
      status: "CHECKING",
      updatedAt: "2026-06-14T01:02:03.000Z",
      lastCheckResult: "REWORK",
      pendingCheckSummary: "waiting on coverage evidence",
      reopenCount: 1,
      repairCycle: 2,
      dependsOnLaneIDs: [],
      coordinatorSessionID: "ses_coord",
      checkerSessionID: "ses_checker",
    }])
    expect(snapshot.agents).toEqual([
      {
        instanceID: "inst_coord",
        role: "coordinator",
        sessionID: "ses_coord",
        orchestratorSessionID: "ses_orch",
        status: "ALIVE",
        laneIDs: ["lane_1"],
      },
      {
        instanceID: "inst_checker",
        role: "checker",
        sessionID: "ses_checker",
        orchestratorSessionID: "ses_orch",
        status: "BUSY",
        laneIDs: ["lane_1"],
      },
    ])
    expect(snapshot.diagnostics.map((item) => item.id)).toEqual([
      "legacy-debug-fallback",
      "outbox-failed",
      "pending-delivery",
      "pending-wake",
    ])
    expect(snapshot.diagnostics[0]).toMatchObject({
      severity: "warn",
      title: "Legacy IC Agent state DB fallback",
      evidence: stateDb,
      readonly: true,
    })
    expect(snapshot.artifacts.map((item) => item.title).sort()).toEqual([
      "compile.log",
      "coverage.html",
      "coverage.md",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reads every workflow lane instead of silently truncating the lane board", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const stateDir = path.join(project, ".ic-agent")
    mkdirSync(stateDir, { recursive: true })

    const stateDb = path.join(stateDir, "state.db")
    const db = new Database(stateDb)
    try {
      db.exec(`
        create table schema_migrations (
          version text primary key
        );
        create table workflows (
          id text,
          status text,
          goal text
        );
        create table lanes (
          id text,
          name text,
          status text,
          updated_at text,
          last_check_result text,
          pending_check_summary text,
          reopen_count integer,
          repair_cycle integer,
          depends_on_lane_ids_json text
        );

        insert into workflows values ('wf_many', 'active', 'many lanes');
      `)
      db.query("insert into schema_migrations values (?)").run(REQUIRED_IC_AGENT_MIGRATION)

      const insertLane = db.query(`
        insert into lanes values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (let index = 1; index <= 20; index++) {
        const id = `lane_${String(index).padStart(2, "0")}`
        const dependency = index > 1 ? [`lane_${String(index - 1).padStart(2, "0")}`] : []
        insertLane.run(
          id,
          `lane ${index}`,
          index === 20 ? "BLOCKED" : "DONE",
          `2026-06-14T00:${String(index).padStart(2, "0")}:00.000Z`,
          null,
          null,
          index % 3,
          0,
          JSON.stringify(dependency),
        )
      }
    } finally {
      db.close()
    }

    const snapshot = await readIcWorkflowSnapshot(project)

    expect(snapshot.lanes).toHaveLength(20)
    expect(snapshot.lanes.map((lane) => lane.id).slice(0, 3)).toEqual([
      "lane_01",
      "lane_02",
      "lane_03",
    ])
    expect(snapshot.lanes.at(-1)).toMatchObject({
      id: "lane_20",
      name: "lane 20",
      status: "BLOCKED",
      dependsOnLaneIDs: ["lane_19"],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports stale IC Agent schema as a runtime diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const stateDir = path.join(project, ".motryx", "db", "orchestrators", "ses_orch")
    mkdirSync(stateDir, { recursive: true })
    const stateDb = path.join(stateDir, "ic-agent.db")
    const db = new Database(stateDb)
    try {
      db.exec(`
        create table schema_migrations (
          version text primary key
        );
        create table workflows (
          id text,
          status text,
          goal text
        );
        create table lanes (
          id text,
          name text,
          status text,
          updated_at text,
          last_check_result text,
          pending_check_summary text,
          reopen_count integer,
          repair_cycle integer,
          depends_on_lane_ids_json text
        );

        insert into schema_migrations values ('v2_0018_waiver_audit');
        insert into workflows values ('wf_stale', 'active', 'stale schema');
      `)
    } finally {
      db.close()
    }

    const snapshot = await readIcWorkflowSnapshot(project)

    expect(snapshot.workflow?.id).toBe("wf_stale")
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      id: "ic-agent-schema-stale",
      severity: "warn",
      source: "ic.state_db.schema_migrations",
      targetType: "runtime",
      targetID: "ic-agent-db",
      recommendation: expect.stringContaining("motryx migrate"),
      evidence: stateDb,
      readonly: true,
    }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prefers the current Motryx orchestrator binding over legacy project state", async () => {
  const previousChannelDb = process.env.MOTRYX_CHANNEL_DB
  const previousSession = process.env.MOTRYX_ORCHESTRATOR_SESSION_ID
  const previousDbPath = process.env.MOTRYX_IC_AGENT_DB_PATH
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const legacyDir = path.join(project, ".ic-agent")
    const boundDir = path.join(project, ".motryx", "db", "orchestrators", "ses_orch")
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(boundDir, { recursive: true })
    const legacyDb = path.join(legacyDir, "state.db")
    const boundDb = path.join(boundDir, "ic-agent.db")
    const channelDb = path.join(project, ".motryx", "db", "channel.db")
    createTinyWorkflowDb(legacyDb, "wf_legacy")
    createTinyWorkflowDb(boundDb, "wf_bound")
    const channel = new Database(channelDb)
    try {
      channel.exec(`
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
      channel.query("insert into orchestrator_bindings values (?, ?, ?, 1, 'now', 'now')").run(project, "ses_orch", boundDb)
    } finally {
      channel.close()
    }

    process.env.MOTRYX_CHANNEL_DB = channelDb
    process.env.MOTRYX_ORCHESTRATOR_SESSION_ID = "ses_orch"
    delete process.env.MOTRYX_IC_AGENT_DB_PATH

    const snapshot = await readIcWorkflowSnapshot(project)

    expect(snapshot.stateDb).toBe(boundDb)
    expect(snapshot.stateDbSource).toMatchObject({
      kind: "orchestrator-binding",
      legacy: false,
      productTruth: true,
    })
    expect(snapshot.workflow?.id).toBe("wf_bound")
  } finally {
    rmSync(root, { recursive: true, force: true })
    restoreEnv("MOTRYX_CHANNEL_DB", previousChannelDb)
    restoreEnv("MOTRYX_ORCHESTRATOR_SESSION_ID", previousSession)
    restoreEnv("MOTRYX_IC_AGENT_DB_PATH", previousDbPath)
  }
})

test("switches workflow snapshot when the selected Motryx orchestrator changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const dataRoot = path.join(project, ".motryx", "db")
    const channelDb = path.join(dataRoot, "channel.db")
    const orchADb = path.join(dataRoot, "orchestrators", "ses_orch_a", "ic-agent.db")
    const orchBDb = path.join(dataRoot, "orchestrators", "ses_orch_b", "ic-agent.db")
    const legacyDb = path.join(project, ".ic-agent", "state.db")
    mkdirSync(path.dirname(channelDb), { recursive: true })
    createTinyWorkflowDb(orchADb, "wf_orch_a")
    createTinyWorkflowDb(orchBDb, "wf_orch_b")
    createTinyWorkflowDb(legacyDb, "wf_legacy")

    const channel = new Database(channelDb)
    try {
      channel.exec(`
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
      const insert = channel.query("insert into orchestrator_bindings values (?, ?, ?, 1, ?, ?)")
      insert.run(project, "ses_orch_a", orchADb, "2026-06-16T01:00:00.000Z", "2026-06-16T01:00:00.000Z")
      insert.run(project, "ses_orch_b", orchBDb, "2026-06-16T02:00:00.000Z", "2026-06-16T02:00:00.000Z")
    } finally {
      channel.close()
    }

    const baseEnv = {
      OPENCODE_DB: "motryx.db",
      XDG_DATA_HOME: dataRoot,
      MOTRYX_ORCHESTRATOR_SESSION_ID: "ses_orch_a",
    }
    const resumedContext = resolveMotryxProjectContext({
      projectDir: project,
      env: baseEnv,
    })
    const switchedContext = resolveMotryxProjectContext({
      projectDir: project,
      selectedSessionID: "ses_orch_b",
      env: baseEnv,
    })

    const resumedSnapshot = await readIcWorkflowSnapshot(project, { projectContext: resumedContext })
    const switchedSnapshot = await readIcWorkflowSnapshot(project, { projectContext: switchedContext })

    expect(resumedContext.currentOrchestratorSessionID).toBe("ses_orch_a")
    expect(switchedContext.currentOrchestratorSessionID).toBe("ses_orch_b")
    expect(resumedSnapshot.stateDb).toBe(orchADb)
    expect(switchedSnapshot.stateDb).toBe(orchBDb)
    expect(resumedSnapshot.workflow?.id).toBe("wf_orch_a")
    expect(switchedSnapshot.workflow?.id).toBe("wf_orch_b")
    expect(resumedSnapshot.lanes.map((lane) => lane.id)).toEqual(["lane_wf_orch_a"])
    expect(switchedSnapshot.lanes.map((lane) => lane.id)).toEqual(["lane_wf_orch_b"])
    expect([resumedSnapshot.workflow?.id, switchedSnapshot.workflow?.id]).not.toContain("wf_legacy")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("uses project context instead of env resume session when scanning latest Motryx DB", async () => {
  const previousResume = process.env.MOTRYX_RESUME_SESSION
  const previousOrchestrator = process.env.MOTRYX_ORCHESTRATOR_SESSION_ID
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const orchDb = path.join(project, ".motryx", "db", "orchestrators", "ses_orch", "ic-agent.db")
    createTinyWorkflowDb(orchDb, "wf_orch")
    process.env.MOTRYX_RESUME_SESSION = "ses_coord_internal"
    delete process.env.MOTRYX_ORCHESTRATOR_SESSION_ID

    const snapshot = await readIcWorkflowSnapshot(project, {
      projectContext: {
        product: "Motryx",
        projectDir: project,
        dataRoot: path.join(project, ".motryx", "db"),
        channelDbPath: path.join(project, ".motryx", "db", "channel.db"),
        motryxSessionDbPath: path.join(project, ".motryx", "db", "opencode", "motryx.db"),
        bindingStatus: "none",
      },
    })

    expect(snapshot.stateDb).toBe(orchDb)
    expect(snapshot.stateDbSource).toMatchObject({
      kind: "orchestrator-latest",
      legacy: false,
      productTruth: true,
    })
    expect(snapshot.workflow?.id).toBe("wf_orch")
  } finally {
    rmSync(root, { recursive: true, force: true })
    restoreEnv("MOTRYX_RESUME_SESSION", previousResume)
    restoreEnv("MOTRYX_ORCHESTRATOR_SESSION_ID", previousOrchestrator)
  }
})

test("recovers the owning orchestrator DB when a binding points at an empty internal agent DB", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const dataRoot = path.join(project, ".motryx", "db")
    const ownerDb = path.join(dataRoot, "orchestrators", "ses_orch", "ic-agent.db")
    const internalDb = path.join(dataRoot, "orchestrators", "ses_coord", "ic-agent.db")
    createTinyWorkflowDb(ownerDb, "wf_owner")
    mkdirSync(path.dirname(internalDb), { recursive: true })
    new Database(internalDb).close()

    const owner = new Database(ownerDb)
    try {
      owner.exec(`
        create table agent_instances (
          instance_id text,
          role text,
          session_id text,
          orchestrator_session_id text,
          status text
        );
        insert into agent_instances values ('inst_orch', 'orchestrator', 'ses_orch', 'ses_orch', 'ALIVE');
        insert into agent_instances values ('inst_coord', 'coordinator', 'ses_coord', 'ses_orch', 'ALIVE');
      `)
    } finally {
      owner.close()
    }

    const snapshot = await readIcWorkflowSnapshot(project, {
      projectContext: {
        product: "Motryx",
        projectDir: project,
        dataRoot,
        channelDbPath: path.join(dataRoot, "channel.db"),
        motryxSessionDbPath: path.join(dataRoot, "opencode", "motryx.db"),
        currentOrchestratorSessionID: "ses_coord",
        currentIcAgentDbPath: internalDb,
        bindingStatus: "bound",
      },
    })

    expect(snapshot.stateDb).toBe(ownerDb)
    expect(snapshot.stateDbSource).toMatchObject({
      kind: "internal-agent-owner",
      legacy: false,
      productTruth: true,
    })
    expect(snapshot.workflow?.id).toBe("wf_owner")
    expect(snapshot.agents.map((agent) => [agent.role, agent.sessionID])).toEqual([
      ["orchestrator", "ses_orch"],
      ["coordinator", "ses_coord"],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("does not scan legacy workflow DBs when current Motryx context has no binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const legacyDir = path.join(project, ".ic-agent")
    mkdirSync(legacyDir, { recursive: true })
    const legacyDb = path.join(legacyDir, "state.db")
    createTinyWorkflowDb(legacyDb, "wf_legacy")

    const snapshot = await readIcWorkflowSnapshot(project, {
      projectContext: {
        product: "Motryx",
        projectDir: project,
        dataRoot: path.join(project, ".motryx", "db"),
        channelDbPath: path.join(project, ".motryx", "db", "channel.db"),
        motryxSessionDbPath: path.join(project, ".motryx", "db", "opencode", "motryx.db"),
        currentOrchestratorSessionID: "ses_missing",
        bindingStatus: "missing-binding",
      },
    })

    expect(snapshot.workflow).toBeUndefined()
    expect(snapshot.stateDb).toBeUndefined()
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      id: "motryx-binding-missing",
      sessionID: "ses_missing",
      evidence: path.join(project, ".motryx", "db", "channel.db"),
    }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports a missing current IC Agent DB instead of scanning latest orchestrator DB", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const otherDir = path.join(project, ".motryx", "db", "orchestrators", "ses_other")
    mkdirSync(otherDir, { recursive: true })
    createTinyWorkflowDb(path.join(otherDir, "ic-agent.db"), "wf_other")
    const missingDb = path.join(project, ".motryx", "db", "orchestrators", "ses_current", "ic-agent.db")

    const snapshot = await readIcWorkflowSnapshot(project, {
      projectContext: {
        product: "Motryx",
        projectDir: project,
        dataRoot: path.join(project, ".motryx", "db"),
        channelDbPath: path.join(project, ".motryx", "db", "channel.db"),
        motryxSessionDbPath: path.join(project, ".motryx", "db", "opencode", "motryx.db"),
        currentOrchestratorSessionID: "ses_current",
        currentIcAgentDbPath: missingDb,
        bindingStatus: "bound",
      },
    })

    expect(snapshot.workflow).toBeUndefined()
    expect(snapshot.stateDb).toBeUndefined()
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
      id: "ic-agent-db-missing",
      sessionID: "ses_current",
      evidence: missingDb,
    }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("prefers the Motryx workflow read API when configured", async () => {
  const previousApiURL = process.env.MOTRYX_WORKFLOW_API_URL
  const previousApi = process.env.MOTRYX_WORKFLOW_API
  const previousToken = process.env.MOTRYX_WORKFLOW_API_TOKEN
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer test-token")
      expect(new URL(request.url).searchParams.get("orchestrator_session_id")).toBe("ses_api_orch")
      return Response.json({
        status: "ok",
        stateDb: "/remote/.ic-agent/state.db",
        workflow: {
          id: "wf_api",
          status: "active",
          goal: "remote workflow",
        },
        lanes: [{
          id: "lane_api",
          name: "api lane",
          status: "WORKING",
          updatedAt: "2026-06-16T12:00:00.000Z",
          reopenCount: 3,
          repairCycle: 1,
          dependsOnLaneIDs: ["lane_dep"],
        }],
        agents: [{
          instanceID: "inst_api",
          role: "coordinator",
          sessionID: "ses_api",
          status: "BUSY",
          laneIDs: ["lane_api"],
        }],
        diagnostics: [{
          id: "api-diagnostic",
          severity: "warn",
          title: "API diagnostic",
          detail: "from sidecar",
          source: "motryx.workflow_api",
          targetType: "lane",
          targetID: "lane_api",
          recommendation: "read API context",
        }],
      })
    },
  })
  try {
    process.env.MOTRYX_WORKFLOW_API_URL = `http://127.0.0.1:${server.port}`
    process.env.MOTRYX_WORKFLOW_API_TOKEN = "test-token"
    delete process.env.MOTRYX_WORKFLOW_API

    const snapshot = await readIcWorkflowSnapshot("/tmp/no-local-workflow", {
      projectContext: {
        product: "Motryx",
        projectDir: "/tmp/no-local-workflow",
        dataRoot: "/tmp/no-local-workflow/.motryx/db",
        channelDbPath: "/tmp/no-local-workflow/.motryx/db/channel.db",
        motryxSessionDbPath: "/tmp/no-local-workflow/.motryx/db/opencode/motryx.db",
        currentOrchestratorSessionID: "ses_api_orch",
        bindingStatus: "missing-binding",
      },
    })

    expect(snapshot.stateDb).toBe("/remote/.ic-agent/state.db")
    expect(snapshot.workflow?.id).toBe("wf_api")
    expect(snapshot.lanes).toEqual([{
      id: "lane_api",
      name: "api lane",
      status: "WORKING",
      updatedAt: "2026-06-16T12:00:00.000Z",
      lastCheckResult: undefined,
      pendingCheckSummary: undefined,
      reopenCount: 3,
      repairCycle: 1,
      dependsOnLaneIDs: ["lane_dep"],
      coordinatorSessionID: undefined,
      checkerSessionID: undefined,
    }])
    expect(snapshot.agents).toEqual([{
      instanceID: "inst_api",
      role: "coordinator",
      sessionID: "ses_api",
      status: "BUSY",
      laneIDs: ["lane_api"],
    }])
    expect(snapshot.artifacts).toEqual([])
    expect(snapshot.diagnostics[0]).toMatchObject({
      id: "api-diagnostic",
      severity: "warn",
      targetType: "lane",
      targetID: "lane_api",
      readonly: true,
    })
  } finally {
    server.stop(true)
    restoreEnv("MOTRYX_WORKFLOW_API_URL", previousApiURL)
    restoreEnv("MOTRYX_WORKFLOW_API", previousApi)
    restoreEnv("MOTRYX_WORKFLOW_API_TOKEN", previousToken)
  }
})

test("falls back to local workflow state when the configured read API is unavailable", async () => {
  const previousApiURL = process.env.MOTRYX_WORKFLOW_API_URL
  const previousApi = process.env.MOTRYX_WORKFLOW_API
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-tui-"))
  try {
    const project = path.join(root, "project")
    const stateDir = path.join(project, ".ic-agent")
    mkdirSync(stateDir, { recursive: true })
    const stateDb = path.join(stateDir, "state.db")
    const db = new Database(stateDb)
    try {
      db.exec(`
        create table schema_migrations (
          version text primary key
        );
        create table workflows (
          id text,
          status text,
          goal text
        );
        create table lanes (
          id text,
          name text,
          status text,
          updated_at text,
          last_check_result text,
          pending_check_summary text,
          reopen_count integer,
          repair_cycle integer,
          depends_on_lane_ids_json text
        );

        insert into workflows values ('wf_local', 'active', 'local fallback');
        insert into lanes values ('lane_local', 'local lane', 'DONE', null, null, null, 0, 0, '[]');
      `)
      db.query("insert into schema_migrations values (?)").run(REQUIRED_IC_AGENT_MIGRATION)
    } finally {
      db.close()
    }

    process.env.MOTRYX_WORKFLOW_API_URL = "not-a-url"
    delete process.env.MOTRYX_WORKFLOW_API

    const snapshot = await readIcWorkflowSnapshot(project)

    expect(snapshot.workflow?.id).toBe("wf_local")
    expect(snapshot.lanes.map((lane) => lane.id)).toEqual(["lane_local"])
    expect(snapshot.diagnostics[0]).toMatchObject({
      id: "workflow-api-unavailable",
      severity: "warn",
      source: "motryx.workflow_api",
      targetType: "runtime",
      targetID: "workflow-api",
      readonly: true,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
    restoreEnv("MOTRYX_WORKFLOW_API_URL", previousApiURL)
    restoreEnv("MOTRYX_WORKFLOW_API", previousApi)
  }
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function createTinyWorkflowDb(stateDb: string, workflowID: string) {
  mkdirSync(path.dirname(stateDb), { recursive: true })
  const db = new Database(stateDb)
  try {
    db.exec(`
      create table schema_migrations (
        version text primary key
      );
      create table workflows (
        id text,
        status text,
        goal text
      );
      create table lanes (
        id text,
        name text,
        status text,
        updated_at text,
        last_check_result text,
        pending_check_summary text,
        reopen_count integer,
        repair_cycle integer,
        depends_on_lane_ids_json text
      );

      insert into workflows values ('${workflowID}', 'active', 'bound workflow');
      insert into lanes values ('lane_${workflowID}', 'lane ${workflowID}', 'DONE', null, null, null, 0, 0, '[]');
    `)
    db.query("insert into schema_migrations values (?)").run(REQUIRED_IC_AGENT_MIGRATION)
  } finally {
    db.close()
  }
}
