import { Database } from "bun:sqlite"
import { SessionV2 } from "@opencode-ai/core/session"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

export type MotryxOrchestratorBinding = {
  projectID: string
  orchestratorSessionID: string
  icAgentDbPath: string
  schemaVersion: number
  createdAt: string
  updatedAt: string
}

export type MotryxRuntimePaths = {
  projectDir: string
  dataRoot: string
  channelDb: string
}

const BINDING_SCHEMA_VERSION = 1

export function createMotryxOrchestratorSessionID() {
  return SessionV2.ID.create()
}

export function resolveMotryxRuntimePaths(input: {
  projectDir: string
  env?: Record<string, string | undefined>
}): MotryxRuntimePaths {
  const env = input.env ?? process.env
  const projectDir = path.resolve(input.projectDir || env.MOTRYX_PROJECT_DIR || process.cwd())
  const dataRoot = path.resolve(env.MOTRYX_DATA_ROOT || env.XDG_DATA_HOME || path.join(projectDir, ".motryx", "db"))
  const channelDb = path.resolve(env.MOTRYX_CHANNEL_DB || path.join(dataRoot, "channel.db"))
  return { projectDir, dataRoot, channelDb }
}

export function ensureMotryxOrchestratorBinding(input: {
  projectDir: string
  sessionID: string
  env?: Record<string, string | undefined>
}): MotryxOrchestratorBinding {
  const paths = resolveMotryxRuntimePaths({ projectDir: input.projectDir, env: input.env })
  mkdirSync(path.dirname(paths.channelDb), { recursive: true })
  const db = new Database(paths.channelDb)
  try {
    ensureSchema(db)
    const existing = readBinding(db, paths.projectDir, input.sessionID)
    if (existing) {
      applyBindingEnv(existing, paths, input.env)
      return existing
    }
    const now = new Date().toISOString()
    const icAgentDbPath = path.join(paths.dataRoot, "orchestrators", sanitizeSessionID(input.sessionID), "ic-agent.db")
    mkdirSync(path.dirname(icAgentDbPath), { recursive: true })
    db.query(`
      insert into orchestrator_bindings (
        project_id,
        orchestrator_session_id,
        ic_agent_db_path,
        schema_version,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?)
    `).run(paths.projectDir, input.sessionID, icAgentDbPath, BINDING_SCHEMA_VERSION, now, now)
    const created = readBinding(db, paths.projectDir, input.sessionID)
    if (!created) throw new Error("Motryx orchestrator binding was not persisted")
    applyBindingEnv(created, paths, input.env)
    return created
  } finally {
    db.close()
  }
}

export function currentMotryxBindingFromEnv(env: Record<string, string | undefined> = process.env) {
  const sessionID = env.MOTRYX_ORCHESTRATOR_SESSION_ID || env.MOTRYX_RESUME_SESSION || ""
  const icAgentDbPath = env.MOTRYX_IC_AGENT_DB_PATH || env.IC_AGENT_DB_PATH || ""
  if (!sessionID || !icAgentDbPath) return undefined
  return {
    orchestratorSessionID: sessionID,
    icAgentDbPath,
  }
}

export function readMotryxOrchestratorBinding(input: {
  projectDir: string
  sessionID: string
  env?: Record<string, string | undefined>
}): MotryxOrchestratorBinding | undefined {
  const paths = resolveMotryxRuntimePaths({ projectDir: input.projectDir, env: input.env })
  if (!existsSync(paths.channelDb)) return undefined
  const db = new Database(paths.channelDb, { readonly: true })
  try {
    return readBinding(db, paths.projectDir, input.sessionID)
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

function ensureSchema(db: Database) {
  db.exec(`
    create table if not exists orchestrator_bindings (
      project_id text not null,
      orchestrator_session_id text not null,
      ic_agent_db_path text not null,
      schema_version integer not null,
      created_at text not null,
      updated_at text not null,
      primary key (project_id, orchestrator_session_id)
    );
    create index if not exists idx_orchestrator_bindings_project_updated
      on orchestrator_bindings(project_id, updated_at);
  `)
}

function readBinding(db: Database, projectDir: string, sessionID: string): MotryxOrchestratorBinding | undefined {
  return db.query<MotryxOrchestratorBinding, [string, string]>(`
    select project_id as projectID,
           orchestrator_session_id as orchestratorSessionID,
           ic_agent_db_path as icAgentDbPath,
           schema_version as schemaVersion,
           created_at as createdAt,
           updated_at as updatedAt
      from orchestrator_bindings
     where project_id = ?
       and orchestrator_session_id = ?
  `).get(projectDir, sessionID) ?? undefined
}

function applyBindingEnv(
  binding: MotryxOrchestratorBinding,
  paths: MotryxRuntimePaths,
  env: Record<string, string | undefined> | undefined,
) {
  const target = env ?? process.env
  target.MOTRYX_PROJECT_DIR = paths.projectDir
  target.MOTRYX_DATA_ROOT = paths.dataRoot
  target.MOTRYX_CHANNEL_DB = paths.channelDb
  target.MOTRYX_ORCHESTRATOR_SESSION_ID = binding.orchestratorSessionID
  target.MOTRYX_IC_AGENT_DB_PATH = binding.icAgentDbPath
  target.IC_AGENT_DB_PATH = binding.icAgentDbPath
}

function sanitizeSessionID(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_")
}

export function motryxBindingExists(input: {
  projectDir: string
  sessionID: string
  env?: Record<string, string | undefined>
}) {
  const paths = resolveMotryxRuntimePaths({ projectDir: input.projectDir, env: input.env })
  if (!existsSync(paths.channelDb)) return false
  const db = new Database(paths.channelDb, { readonly: true })
  try {
    return Boolean(readBinding(db, paths.projectDir, input.sessionID))
  } catch {
    return false
  } finally {
    db.close()
  }
}
