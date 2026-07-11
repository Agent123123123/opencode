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
  readMotryxOrchestratorBinding,
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

test("reads a headless-created orchestrator binding as the same TUI product truth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "motryx-headless-binding-"))
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          data: {
            id: "ses_headless_tui_equiv",
            agent: "orchestrator",
            title: "Motryx orchestrator",
            directory: url.searchParams.get("directory"),
          },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  try {
    const project = path.join(root, "project")
    const stateRoot = path.join(root, "state")
    const dataRoot = path.join(root, "data")
    const channelDb = path.join(dataRoot, "channel.db")
    const sessionDb = path.join(dataRoot, "opencode", "motryx.db")
    mkdirSync(project, { recursive: true })
    const helper = path.resolve(import.meta.dir, "../../../../../scripts/motryx-headless.mjs")
    const proc = Bun.spawn([
      "bun",
      helper,
      "serve",
      "--project",
      project,
      "--state-root",
      stateRoot,
      "--data-root",
      dataRoot,
      "--channel-db",
      channelDb,
      "--session-db",
      sessionDb,
      "--mode",
      "new",
      "--server-url",
      `http://127.0.0.1:${server.port}`,
      "--json",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
    const binding = readMotryxOrchestratorBinding({
      projectDir: project,
      sessionID: "ses_headless_tui_equiv",
      env: {
        MOTRYX_DATA_ROOT: dataRoot,
        MOTRYX_CHANNEL_DB: channelDb,
      },
    })

    expect(binding).toMatchObject({
      projectID: project,
      orchestratorSessionID: "ses_headless_tui_equiv",
      icAgentDbPath: path.join(dataRoot, "orchestrators", "ses_headless_tui_equiv", "ic-agent.db"),
      schemaVersion: 2,
    })
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})
