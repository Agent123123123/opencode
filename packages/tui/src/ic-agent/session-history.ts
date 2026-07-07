import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

const REQUIRED_IC_AGENT_MIGRATION = "v2_0019_agent_orchestrator_binding"

export type MotryxSessionHistoryItem = {
  handle: string
  id: string
  title: string
  agent: string
  created?: number
  createdText?: string
  updated: number
  updatedText: string
  messageCount: number
  bindingStatus: "bound" | "missing-ic-db" | "stale-schema"
  icAgentDbPath?: string
  requiredMigration?: string
  workflowSummary?: MotryxWorkflowSummary
}

export type MotryxWorkflowSummary = {
  status: "ok" | "empty" | "missing-db" | "unreadable"
  workflowID?: string
  workflowStatus?: string
  goalPreview?: string
  lanes: number
  active: number
  blocked: number
  checking: number
  done: number
}

export type MotryxSessionHistory = {
  status: "ok" | "empty" | "missing_db" | "missing_session_table" | "error"
  projectDir: string
  dbPath: string
  sessions: MotryxSessionHistoryItem[]
  error?: string
}

export async function readMotryxSessionHistory(input: {
  projectDir?: string
  dbPath?: string
  limit?: number
  env?: Record<string, string | undefined>
} = {}): Promise<MotryxSessionHistory> {
  const env = input.env ?? process.env
  const projectDir = resolve(input.projectDir || env.MOTRYX_PROJECT_DIR || process.cwd())
  const dbPath = resolveMotryxDbPath({ env, dbPath: input.dbPath })
  if (!existsSync(dbPath)) {
    return { status: "missing_db", projectDir, dbPath, sessions: [] }
  }

  let db: Database
  try {
    db = new Database(dbPath, { readonly: true })
  } catch (error) {
    return {
      status: "error",
      projectDir,
      dbPath,
      sessions: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    if (!tableExists(db, "session")) {
      return { status: "missing_session_table", projectDir, dbPath, sessions: [] }
    }
    const { rows, hasMessage } = readSessions(db, {
      projectDir,
      limit: input.limit ?? 30,
    })
    const bindings = readBindings(resolveMotryxChannelDbPath({ env, projectDir }), projectDir)
    const sessions = rows
      .filter((row) => isOrchestratorLike(row))
      .map((row, index) => sessionSummary(db, {
        row,
        index,
        hasMessage,
        binding: bindings.get(String(row.id)),
      }))

    return {
      status: sessions.length ? "ok" : "empty",
      projectDir,
      dbPath,
      sessions,
    }
  } catch (error) {
    return {
      status: "error",
      projectDir,
      dbPath,
      sessions: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    db.close()
  }
}

function resolveMotryxDbPath(input: {
  env: Record<string, string | undefined>
  dbPath?: string
}) {
  if (input.dbPath) return resolve(input.dbPath)
  const dbName = input.env.OPENCODE_DB || "motryx.db"
  if (isAbsolute(dbName)) return dbName
  const dataHome = input.env.XDG_DATA_HOME || join(input.env.HOME || process.cwd(), ".local", "share")
  const canonical = join(dataHome, "opencode", dbName)
  const legacy = join(dataHome, "opencode", "opencode-local.db")
  if (dbName === "motryx.db" && !existsSync(canonical) && existsSync(legacy)) return legacy
  return canonical
}

function resolveMotryxChannelDbPath(input: {
  env: Record<string, string | undefined>
  projectDir: string
}) {
  if (input.env.MOTRYX_CHANNEL_DB) return resolve(input.env.MOTRYX_CHANNEL_DB)
  const dataRoot = input.env.MOTRYX_DATA_ROOT || input.env.XDG_DATA_HOME || join(input.projectDir, ".motryx", "db")
  return resolve(dataRoot, "channel.db")
}

function sessionSummary(db: Database, input: {
  row: SessionRow
  index: number
  hasMessage: boolean
  binding?: {
    icAgentDbPath: string
  }
}): MotryxSessionHistoryItem {
  const id = String(input.row.id)
  const updated = Number(input.row.time_updated || 0)
  const defaultStarted = defaultSessionStartedAt(String(input.row.title || ""))
  const created = Number(input.row.time_created || 0) || defaultStarted || undefined
  const item: MotryxSessionHistoryItem = {
    handle: `@${input.index + 1}`,
    id,
    title: cleanTitle(String(input.row.title || id)),
    agent: input.row.agent ? String(input.row.agent) : "orchestrator",
    created,
    createdText: created ? `started ${formatLocalTime(created)}` : undefined,
    updated,
    updatedText: updated ? `updated ${formatLocalTime(updated)}` : "updated unknown",
    messageCount: input.hasMessage ? messageCount(db, id) : 0,
    bindingStatus: bindingStatus(input.binding?.icAgentDbPath),
  }
  if (input.binding) {
    item.icAgentDbPath = input.binding.icAgentDbPath
    if (item.bindingStatus === "stale-schema") item.requiredMigration = REQUIRED_IC_AGENT_MIGRATION
    item.workflowSummary = readWorkflowSummary(input.binding.icAgentDbPath)
  }
  return item
}

function bindingStatus(icAgentDbPath?: string): MotryxSessionHistoryItem["bindingStatus"] {
  if (!icAgentDbPath || !existsSync(icAgentDbPath)) return "missing-ic-db"
  return icAgentSchemaStale(icAgentDbPath) ? "stale-schema" : "bound"
}

function readWorkflowSummary(icAgentDbPath: string): MotryxWorkflowSummary {
  if (!existsSync(icAgentDbPath)) {
    return emptyWorkflowSummary("missing-db")
  }
  let db: Database | undefined
  try {
    db = new Database(icAgentDbPath, { readonly: true })
    if (!tableExists(db, "workflows") || !tableExists(db, "lanes")) return emptyWorkflowSummary("empty")
    const workflow = db.query(`
      SELECT id, status, goal
        FROM workflows
       ORDER BY rowid DESC
       LIMIT 1
    `).get() as { id?: unknown; status?: unknown; goal?: unknown } | undefined
    const rows = db.query("SELECT status FROM lanes").all() as Array<{ status?: unknown }>
    const statuses = rows.map((row) => String(row.status || "UNKNOWN"))
    return {
      status: workflow || statuses.length ? "ok" : "empty",
      workflowID: workflow?.id ? String(workflow.id) : undefined,
      workflowStatus: workflow?.status ? String(workflow.status) : undefined,
      goalPreview: workflow?.goal ? compactText(String(workflow.goal), 96) : undefined,
      lanes: statuses.length,
      active: statuses.filter((status) => /work|active|progress/i.test(status)).length,
      blocked: statuses.filter((status) => /block|fail|error/i.test(status)).length,
      checking: statuses.filter((status) => /check|review/i.test(status)).length,
      done: statuses.filter((status) => /done|pass|complete/i.test(status)).length,
    }
  } catch {
    return emptyWorkflowSummary("unreadable")
  } finally {
    db?.close()
  }
}

function emptyWorkflowSummary(status: MotryxWorkflowSummary["status"]): MotryxWorkflowSummary {
  return {
    status,
    lanes: 0,
    active: 0,
    blocked: 0,
    checking: 0,
    done: 0,
  }
}

function readBindings(channelDbPath: string, projectDir: string) {
  const bindings = new Map<string, { icAgentDbPath: string }>()
  if (!existsSync(channelDbPath)) return bindings
  let db: Database | undefined
  try {
    db = new Database(channelDbPath, { readonly: true })
    if (!tableExists(db, "orchestrator_bindings")) return bindings
    const rows = db.query<{
      orchestratorSessionID: string
      icAgentDbPath: string
    }, [string]>(`
      select orchestrator_session_id as orchestratorSessionID,
             ic_agent_db_path as icAgentDbPath
        from orchestrator_bindings
       where project_id = ?
    `).all(projectDir)
    for (const row of rows) {
      bindings.set(row.orchestratorSessionID, {
        icAgentDbPath: row.icAgentDbPath,
      })
    }
  } catch {
    return bindings
  } finally {
    db?.close()
  }
  return bindings
}

function icAgentSchemaStale(icAgentDbPath: string) {
  let db: Database | undefined
  try {
    db = new Database(icAgentDbPath, { readonly: true })
    if (!tableExists(db, "schema_migrations")) return true
    const row = db.query<{ version: string }, [string]>(
      "SELECT version FROM schema_migrations WHERE version = ?",
    ).get(REQUIRED_IC_AGENT_MIGRATION)
    return !row
  } catch {
    return true
  } finally {
    db?.close()
  }
}

function readSessions(db: Database, input: {
  projectDir: string
  limit: number
}) {
  const columns = tableColumns(db, "session")
  const hasAgent = columns.has("agent")
  const hasParent = columns.has("parent_id")
  const hasDirectory = columns.has("directory")
  const hasUpdated = columns.has("time_updated")
  const hasCreated = columns.has("time_created")
  const hasTitle = columns.has("title")
  const hasMessage = tableExists(db, "message")
  const agentExpr = hasAgent ? "agent" : "NULL AS agent"
  const parentFilter = hasParent ? "AND parent_id IS NULL" : ""
  const directoryFilter = hasDirectory ? "AND directory = $projectDir" : ""
  const orderExpr = hasUpdated ? "time_updated DESC" : "id DESC"
  const titleExpr = hasTitle ? "title" : "id AS title"

  const rows = db.query(`
    SELECT id,
           ${titleExpr},
           ${agentExpr},
           ${hasUpdated ? "time_updated" : "0 AS time_updated"},
           ${hasCreated ? "time_created" : "0 AS time_created"}
    FROM session
    WHERE 1=1 ${directoryFilter} ${parentFilter}
    ORDER BY ${orderExpr}
    LIMIT $limit
  `).all({
    $projectDir: input.projectDir,
    $limit: Number.isFinite(input.limit) && input.limit > 0 ? input.limit : 30,
  }) as SessionRow[]
  return { rows, hasMessage }
}

type SessionRow = {
  id: unknown
  title?: unknown
  agent?: unknown
  time_created?: unknown
  time_updated?: unknown
}

function tableExists(db: Database, name: string) {
  const row = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name })
  return Boolean(row)
}

function tableColumns(db: Database, name: string) {
  return new Set(db.query(`PRAGMA table_info(${JSON.stringify(name)})`).all().map((row: any) => row.name as string))
}

function messageCount(db: Database, sessionID: string) {
  const row = db.query("SELECT count(*) AS count FROM message WHERE session_id = $sessionID").get({ $sessionID: sessionID }) as
    | { count?: number }
    | undefined
  return Number(row?.count ?? 0)
}

function isOrchestratorLike(row: SessionRow) {
  const agent = String(row.agent || "").toLowerCase()
  const title = String(row.title || "").toLowerCase()
  if (agent) return agent === "orchestrator"
  return !/(checker|coordinator|coord|analyst)/.test(title)
}

function cleanTitle(value: string) {
  const title = value.replace(/\s+/g, " ").trim()
  if (defaultSessionStartedAt(title)) return "Untitled orchestrator"
  return title || "Untitled orchestrator"
}

function compactText(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`
}

function defaultSessionStartedAt(title: string) {
  const match = /^(?:New session|Child session) - (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(title.trim())
  if (!match) return undefined
  const timestamp = Date.parse(match[1]!)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

function formatLocalTime(value: number) {
  if (!value) return "unknown-time"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "unknown-time"
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  const hour = `${date.getHours()}`.padStart(2, "0")
  const minute = `${date.getMinutes()}`.padStart(2, "0")
  return `${year}-${month}-${day} ${hour}:${minute}`
}
