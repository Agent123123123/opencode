import { Database } from "bun:sqlite"
import { existsSync, readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import path from "node:path"
import type { MotryxProjectContext } from "./project-context"

const REQUIRED_IC_AGENT_MIGRATION = "v2_0019_agent_orchestrator_binding"

export type IcWorkflowSnapshot = {
  stateDb?: string
  stateDbSource?: {
    kind: string
    legacy: boolean
    productTruth: boolean
    detail: string
  }
  workflow?: {
    id: string
    status: string
    goal: string
  }
  lanes: Array<{
    id: string
    name: string
    status: string
    updatedAt?: string
    lastCheckResult?: string
    pendingCheckSummary?: string
    reopenCount?: number
    repairCycle?: number
    dependsOnLaneIDs?: string[]
    coordinatorSessionID?: string
    checkerSessionID?: string
  }>
  agents: Array<{
    instanceID: string
    role: string
    sessionID: string
    orchestratorSessionID?: string
    status: string
    laneIDs: string[]
  }>
  artifacts: Array<{
    id: string
    kind: "doc" | "log" | "data" | "report"
    title: string
    path: string
    detail: string
    mtime: number
  }>
  diagnostics: Array<{
    id: string
    severity: "info" | "warn" | "error"
    title: string
    detail: string
    source: string
    targetType: "workflow" | "lane" | "agent" | "session" | "message" | "outbox" | "wake" | "runtime"
    targetID: string
    recommendation: string
    evidence?: string
    readonly?: boolean
    sessionID?: string
  }>
}

export async function readIcWorkflowSnapshot(
  directory: string,
  options: { projectContext?: MotryxProjectContext } = {},
): Promise<IcWorkflowSnapshot> {
  const configuredApiURL = process.env.MOTRYX_WORKFLOW_API_URL || process.env.MOTRYX_WORKFLOW_API || ""
  if (configuredApiURL.trim()) {
    let apiURL = configuredApiURL
    try {
      apiURL = workflowApiURL(configuredApiURL, options.projectContext)
      return await readApiWorkflowSnapshot(apiURL)
    } catch (error) {
      return withApiFallbackDiagnostic(readLocalWorkflowSnapshot(directory, options.projectContext), apiURL, error)
    }
  }
  return readLocalWorkflowSnapshot(directory, options.projectContext)
}

function readLocalWorkflowSnapshot(directory: string, projectContext?: MotryxProjectContext): IcWorkflowSnapshot {
  const candidates = findStateDbs(directory, projectContext)
  for (const stateDb of candidates) {
    const snapshot = readStateDb(stateDb, directory, projectContext)
    if (snapshot.workflow || snapshot.lanes.length > 0 || snapshot.agents.length > 0) return snapshot
  }
  return candidates[0] ? readStateDb(candidates[0], directory, projectContext) : {
    lanes: [],
    agents: [],
    artifacts: [],
    diagnostics: projectContextDiagnostics(projectContext),
  }
}

async function readApiWorkflowSnapshot(apiURL: string): Promise<IcWorkflowSnapshot> {
  const response = await fetch(apiURL, {
    headers: workflowApiHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Motryx workflow API returned ${response.status}`)
  }
  return normalizeApiWorkflowSnapshot(await response.json(), apiURL)
}

function workflowApiHeaders(): HeadersInit {
  const token = process.env.MOTRYX_WORKFLOW_API_TOKEN || process.env.MOTRYX_WORKFLOW_SIDECAR_TOKEN || ""
  return token.trim()
    ? {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      }
    : {
        accept: "application/json",
      }
}

function workflowApiURL(raw: string, projectContext?: MotryxProjectContext) {
  const url = new URL(raw)
  const normalizedPath = url.pathname.replace(/\/+$/, "")
  if (normalizedPath.endsWith("/ic/workflow") || normalizedPath.endsWith("/ic/workflows/current")) {
    url.pathname = normalizedPath
    return workflowApiURLWithContext(url, projectContext)
  }
  url.pathname = `${normalizedPath}/ic/workflow`.replace(/\/+/g, "/")
  return workflowApiURLWithContext(url, projectContext)
}

function workflowApiURLWithContext(url: URL, projectContext?: MotryxProjectContext) {
  if (projectContext?.currentOrchestratorSessionID && !url.searchParams.has("orchestrator_session_id")) {
    url.searchParams.set("orchestrator_session_id", projectContext.currentOrchestratorSessionID)
  }
  return url.toString()
}

function normalizeApiWorkflowSnapshot(data: unknown, apiURL: string): IcWorkflowSnapshot {
  const value = objectRecord(data) ?? {}
  return {
    stateDb: optionalString(value.stateDb),
    stateDbSource: normalizeApiStateDbSource(value.stateDbSource),
    workflow: normalizeApiWorkflow(value.workflow),
    lanes: normalizeApiLanes(value.lanes),
    agents: normalizeApiAgents(value.agents),
    artifacts: [],
    diagnostics: normalizeApiDiagnostics(value.diagnostics, apiURL),
  }
}

function normalizeApiStateDbSource(value: unknown): IcWorkflowSnapshot["stateDbSource"] {
  const source = objectRecord(value)
  if (!source) return undefined
  const kind = optionalString(source.kind)
  if (!kind) return undefined
  return {
    kind,
    legacy: source.legacy === true,
    productTruth: source.productTruth === true,
    detail: optionalString(source.detail) ?? "",
  }
}

function normalizeApiWorkflow(value: unknown): IcWorkflowSnapshot["workflow"] {
  const workflow = objectRecord(value)
  if (!workflow) return undefined
  const id = optionalString(workflow.id)
  if (!id) return undefined
  return {
    id,
    status: optionalString(workflow.status) ?? "UNKNOWN",
    goal: optionalString(workflow.goal) ?? "",
  }
}

function normalizeApiLanes(value: unknown): IcWorkflowSnapshot["lanes"] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const lane = objectRecord(item)
    if (!lane) return undefined
    const id = optionalString(lane.id)
    if (!id) return undefined
    const normalized: IcWorkflowSnapshot["lanes"][number] = {
      id,
      name: optionalString(lane.name) ?? id,
      status: optionalString(lane.status) ?? "UNKNOWN",
      dependsOnLaneIDs: normalizeStringArray(lane.dependsOnLaneIDs),
    }
    const updatedAt = optionalString(lane.updatedAt)
    const lastCheckResult = optionalString(lane.lastCheckResult)
    const pendingCheckSummary = optionalString(lane.pendingCheckSummary)
    const reopenCount = optionalNumber(lane.reopenCount)
    const repairCycle = optionalNumber(lane.repairCycle)
    const coordinatorSessionID = optionalString(lane.coordinatorSessionID)
    const checkerSessionID = optionalString(lane.checkerSessionID)
    if (updatedAt) normalized.updatedAt = updatedAt
    if (lastCheckResult) normalized.lastCheckResult = lastCheckResult
    if (pendingCheckSummary) normalized.pendingCheckSummary = pendingCheckSummary
    if (reopenCount !== undefined) normalized.reopenCount = reopenCount
    if (repairCycle !== undefined) normalized.repairCycle = repairCycle
    if (coordinatorSessionID) normalized.coordinatorSessionID = coordinatorSessionID
    if (checkerSessionID) normalized.checkerSessionID = checkerSessionID
    return normalized
  }).filter((item): item is IcWorkflowSnapshot["lanes"][number] => Boolean(item?.id))
}

function normalizeApiAgents(value: unknown): IcWorkflowSnapshot["agents"] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const agent = objectRecord(item)
    if (!agent) return undefined
    const normalized: IcWorkflowSnapshot["agents"][number] = {
      instanceID: optionalString(agent.instanceID) ?? "",
      role: optionalString(agent.role) ?? "",
      sessionID: optionalString(agent.sessionID) ?? "",
      status: optionalString(agent.status) ?? "",
      laneIDs: normalizeStringArray(agent.laneIDs),
    }
    const orchestratorSessionID = optionalString(agent.orchestratorSessionID) ?? optionalString(agent.orchestrator_session_id)
    if (orchestratorSessionID) normalized.orchestratorSessionID = orchestratorSessionID
    return normalized
  }).filter((item): item is IcWorkflowSnapshot["agents"][number] => Boolean(item?.instanceID))
}

function normalizeApiDiagnostics(value: unknown, apiURL: string): IcWorkflowSnapshot["diagnostics"] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    const diagnostic = objectRecord(item)
    if (!diagnostic) return undefined
    const normalized: IcWorkflowSnapshot["diagnostics"][number] = {
      id: optionalString(diagnostic.id) ?? `api-diagnostic-${index + 1}`,
      severity: normalizeSeverity(diagnostic.severity),
      title: optionalString(diagnostic.title) ?? optionalString(diagnostic.id) ?? "Workflow diagnostic",
      detail: optionalString(diagnostic.detail) ?? "",
      source: optionalString(diagnostic.source) ?? "motryx.workflow_api",
      targetType: normalizeTargetType(diagnostic.targetType),
      targetID: optionalString(diagnostic.targetID) ?? "workflow-api",
      recommendation: optionalString(diagnostic.recommendation) ?? "Review the workflow read API response.",
      evidence: optionalString(diagnostic.evidence) ?? apiURL,
      readonly: diagnostic.readonly === false ? false : true,
    }
    const sessionID = optionalString(diagnostic.sessionID)
    if (sessionID) normalized.sessionID = sessionID
    return normalized
  }).filter((item): item is IcWorkflowSnapshot["diagnostics"][number] => Boolean(item))
}

function withApiFallbackDiagnostic(snapshot: IcWorkflowSnapshot, apiURL: string, error: unknown): IcWorkflowSnapshot {
  return {
    ...snapshot,
    diagnostics: [
      {
        id: "workflow-api-unavailable",
        severity: "warn",
        title: "Motryx workflow API unavailable",
        detail: error instanceof Error ? error.message : String(error),
        source: "motryx.workflow_api",
        targetType: "runtime",
        targetID: "workflow-api",
        recommendation: "Check the Motryx workflow sidecar, or unset MOTRYX_WORKFLOW_API_URL to use local workflow state only.",
        evidence: apiURL,
        readonly: true,
      },
      ...snapshot.diagnostics,
    ],
  }
}

function readStateDb(stateDb: string, directory: string, projectContext?: MotryxProjectContext): IcWorkflowSnapshot {
  const db = new Database(stateDb, { readonly: true, strict: true })
  try {
    const stateDbSource = classifyStateDbSource(stateDb, directory, projectContext)
    const workflow = first<WorkflowRow>(
      db,
      "select id,status,goal from workflows order by rowid desc limit 1",
    )
    const dependencySelect = hasColumn(db, "lanes", "depends_on_lane_ids_json")
      ? "depends_on_lane_ids_json as dependsOnLaneIDsJson"
      : "'[]' as dependsOnLaneIDsJson"
    const laneRows = all<LaneRow>(
      db,
      `select id,
              name,
              status,
              updated_at as updatedAt,
              last_check_result as lastCheckResult,
              pending_check_summary as pendingCheckSummary,
              reopen_count as reopenCount,
              repair_cycle as repairCycle,
              ${dependencySelect}
	         from lanes
	        order by rowid`,
	    )
    const assignments = laneAssignments(db)
    const laneOwners = laneOwnerMap(assignments)
    const agentLanes = agentLaneMap(assignments)
    const lanes = laneRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      updatedAt: row.updatedAt,
      lastCheckResult: row.lastCheckResult,
      pendingCheckSummary: row.pendingCheckSummary,
      reopenCount: row.reopenCount,
      repairCycle: row.repairCycle,
      dependsOnLaneIDs: parseStringArray(row.dependsOnLaneIDsJson),
      coordinatorSessionID: laneOwners.get(row.id)?.coordinatorSessionID,
      checkerSessionID: laneOwners.get(row.id)?.checkerSessionID,
    }))
    const orchestratorSessionSelect = hasColumn(db, "agent_instances", "orchestrator_session_id")
      ? "orchestrator_session_id as orchestratorSessionID"
      : "NULL as orchestratorSessionID"
    const agents = all<AgentRow>(
      db,
      `select instance_id as instanceID,
              role,
              session_id as sessionID,
              ${orchestratorSessionSelect},
              status
         from agent_instances
        order by rowid
        limit 24`,
    ).map((row) => ({
      instanceID: row.instanceID,
      role: row.role,
      sessionID: row.sessionID,
      orchestratorSessionID: row.orchestratorSessionID || undefined,
      status: row.status,
      laneIDs: agentLanes.get(row.instanceID) ?? [],
    }))
    const schemaStale = icAgentSchemaStale(db)
    const failedOutbox = count(db, "select count(*) as count from transactional_outbox where status in ('FAILED','DEAD_LETTER')")
    const pendingDelivery = count(db, "select count(*) as count from messages where delivery_status='PENDING_DELIVERY'")
    const pendingWake = count(db, "select count(*) as count from wake_queue where status='PENDING'")
    const diagnostics = [
      legacyFallbackDiagnostic(stateDbSource, stateDb),
      schemaStale
        ? {
            id: "ic-agent-schema-stale",
            severity: "warn" as const,
            title: "IC Agent DB schema needs migration",
            detail: `missing schema_migrations version ${REQUIRED_IC_AGENT_MIGRATION}`,
            source: "ic.state_db.schema_migrations",
            targetType: "runtime" as const,
            targetID: "ic-agent-db",
            recommendation: "Run motryx migrate for this project before relying on this IC Agent DB.",
            evidence: stateDb,
            readonly: true,
          }
        : undefined,
      failedOutbox > 0
        ? {
            id: "outbox-failed",
            severity: "error" as const,
            title: `${failedOutbox} failed outbox item${failedOutbox === 1 ? "" : "s"}`,
            detail: "transactional_outbox status FAILED/DEAD_LETTER",
            source: "ic.state_db.transactional_outbox",
            targetType: "outbox" as const,
            targetID: "transactional_outbox",
            recommendation: "Inspect blocker context and last_error, then retry or re-route through the IC runtime.",
            evidence: stateDb,
            readonly: true,
          }
        : undefined,
      pendingDelivery > 0
        ? {
            id: "pending-delivery",
            severity: "warn" as const,
            title: `${pendingDelivery} pending delivery item${pendingDelivery === 1 ? "" : "s"}`,
            detail: "messages.delivery_status = PENDING_DELIVERY",
            source: "ic.state_db.messages",
            targetType: "message" as const,
            targetID: "messages",
            recommendation: "Check whether the target agent session is busy or missing before sending more intervention prompts.",
            evidence: stateDb,
            readonly: true,
          }
        : undefined,
      pendingWake > 0
        ? {
            id: "pending-wake",
            severity: "info" as const,
            title: `${pendingWake} pending wake${pendingWake === 1 ? "" : "s"}`,
            detail: "wake_queue status PENDING",
            source: "ic.state_db.wake_queue",
            targetType: "wake" as const,
            targetID: "wake_queue",
            recommendation: "Watch for wake processing; escalate only if the queue stays pending while sessions are idle.",
            evidence: stateDb,
            readonly: true,
          }
        : undefined,
    ].filter((item): item is NonNullable<typeof item> => Boolean(item))

    return {
      stateDb,
      stateDbSource,
      workflow: workflow
        ? {
            id: workflow.id,
            status: workflow.status,
            goal: workflow.goal,
          }
        : undefined,
      lanes,
      agents,
      artifacts: artifactSummaries(stateDb),
      diagnostics,
    }
  } finally {
    db.close()
  }
}

function legacyFallbackDiagnostic(source: NonNullable<IcWorkflowSnapshot["stateDbSource"]>, stateDb: string) {
  if (!source.legacy) return undefined
  return {
    id: "legacy-debug-fallback",
    severity: "warn" as const,
    title: "Legacy IC Agent state DB fallback",
    detail: "This DB is not Motryx product truth. Create or resume an orchestrator binding for normal product use.",
    source: `ic.state_db.${source.kind}`,
    targetType: "runtime" as const,
    targetID: "legacy-state-db",
    recommendation: "Use motryx --resume for a bound orchestrator, or explicitly adopt/repair a binding before relying on workflow state.",
    evidence: stateDb,
    readonly: true,
  }
}

function artifactSummaries(stateDb: string): IcWorkflowSnapshot["artifacts"] {
  const runDirectory = path.dirname(path.dirname(stateDb))
  const roots = [
    path.join(runDirectory, "docs"),
    path.join(runDirectory, ".ic-agent"),
    path.join(runDirectory, "dv"),
  ]
  return roots
    .flatMap((root) => scanArtifacts(runDirectory, root))
    .toSorted((left, right) => right.mtime - left.mtime)
    .slice(0, 20)
    .map((item, index) => ({
      id: `artifact:${index}:${item.relative}`,
      kind: item.kind,
      title: item.title,
      path: item.file,
      detail: `${item.relative} · ${formatBytes(item.size)}`,
      mtime: item.mtime,
    }))
}

function scanArtifacts(runDirectory: string, root: string) {
  const result: Array<{
    file: string
    relative: string
    title: string
    kind: IcWorkflowSnapshot["artifacts"][number]["kind"]
    size: number
    mtime: number
  }> = []
  if (!existsSync(root)) return result
  const visit = (dir: string, depth: number) => {
    if (depth > 3 || result.length >= 80) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (result.length >= 80) break
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "work" || entry.name === "node_modules") continue
        visit(file, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const kind = artifactKind(file)
      if (!kind) continue
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      result.push({
        file,
        relative: path.relative(runDirectory, file),
        title: entry.name,
        kind,
        size: stat.size,
        mtime: stat.mtimeMs,
      })
    }
  }
  visit(root, 0)
  return result
}

function artifactKind(file: string): IcWorkflowSnapshot["artifacts"][number]["kind"] | undefined {
  const ext = path.extname(file).toLowerCase()
  const name = path.basename(file).toLowerCase()
  if (ext === ".md") return "doc"
  if ([".log", ".txt"].includes(ext)) return "log"
  if ([".json", ".jsonl", ".xml", ".yaml", ".yml"].includes(ext)) return "data"
  if ([".html", ".htm"].includes(ext)) return "report"
  if (name.includes("coverage") || name.includes("report") || name.includes("signoff")) return "report"
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function findStateDbs(directory: string, projectContext?: MotryxProjectContext) {
  const candidates: string[] = []
  const ancestors = ancestorDirectories(directory)
  if (projectContext?.currentIcAgentDbPath) {
    if (!existsSync(projectContext.currentIcAgentDbPath)) return []
    const current = path.resolve(projectContext.currentIcAgentDbPath)
    const owner = ownerDbForInternalSession(directory, projectContext, current)
    return owner ? [owner, current] : [current]
  }
  if (projectContext?.bindingStatus === "missing-binding" || projectContext?.bindingStatus === "alias-unresolved") {
    return []
  }
  const explicit = process.env.MOTRYX_IC_AGENT_DB_PATH || process.env.IC_AGENT_DB_PATH
  if (explicit) return existsSync(explicit) ? [path.resolve(explicit)] : []
  const bound = bindingStateDb(directory, projectContext)
  const requestedSessionID = requestedOrchestratorSessionID(projectContext)
  if (requestedSessionID && !requestedSessionID.startsWith("@")) {
    return bound && existsSync(bound) ? [bound] : []
  }
  for (const item of ancestors) {
    const projectLocal = path.join(item, ".motryx", "db", "orchestrators")
    if (!existsSync(projectLocal)) continue
    const latest = readdirSync(projectLocal, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectLocal, entry.name, "ic-agent.db"))
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: statSync(candidate).mtimeMs }))
      .toSorted((left, right) => right.mtime - left.mtime)
    candidates.push(...latest.map((item) => item.candidate))
  }
  for (const item of ancestors) {
    const candidate = path.join(item, ".ic-agent", "state.db")
    if (existsSync(candidate)) candidates.push(candidate)
  }

  for (const root of ancestors) {
    const runs = path.join(root, "regression", "runs")
    if (!existsSync(runs)) continue
    const latest = readdirSync(runs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runs, entry.name, ".ic-agent", "state.db"))
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: statSync(candidate).mtimeMs }))
      .toSorted((left, right) => right.mtime - left.mtime)
    candidates.push(...latest.map((item) => item.candidate))
  }
  return [...new Set(candidates)]
}

function ownerDbForInternalSession(
  directory: string,
  projectContext: MotryxProjectContext,
  currentDb: string,
) {
  const sessionID = projectContext.currentOrchestratorSessionID
  if (!sessionID || !stateDbLooksEmpty(currentDb)) return undefined
  for (const candidate of projectOrchestratorDbs(directory)) {
    if (path.resolve(candidate) === path.resolve(currentDb)) continue
    if (dbContainsInternalSession(candidate, sessionID)) return candidate
  }
  return undefined
}

function projectOrchestratorDbs(directory: string) {
  const candidates: string[] = []
  for (const item of ancestorDirectories(directory)) {
    const projectLocal = path.join(item, ".motryx", "db", "orchestrators")
    if (!existsSync(projectLocal)) continue
    const latest = readdirSync(projectLocal, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectLocal, entry.name, "ic-agent.db"))
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: statSync(candidate).mtimeMs }))
      .toSorted((left, right) => right.mtime - left.mtime)
    candidates.push(...latest.map((item) => item.candidate))
  }
  return [...new Set(candidates)]
}

function stateDbLooksEmpty(stateDb: string) {
  let db: Database | undefined
  try {
    db = new Database(stateDb, { readonly: true })
    const workflows = tableExists(db, "workflows") ? count(db, "select count(*) as count from workflows") : 0
    const lanes = tableExists(db, "lanes") ? count(db, "select count(*) as count from lanes") : 0
    const agents = tableExists(db, "agent_instances") ? count(db, "select count(*) as count from agent_instances") : 0
    return workflows + lanes + agents === 0
  } catch {
    return false
  } finally {
    db?.close()
  }
}

function dbContainsInternalSession(stateDb: string, sessionID: string) {
  let db: Database | undefined
  try {
    db = new Database(stateDb, { readonly: true })
    if (!tableExists(db, "agent_instances")) return false
    const row = db.query<{ role: string }, [string]>(`
      select role
        from agent_instances
       where session_id = ?
       order by rowid desc
       limit 1
    `).get(sessionID)
    return Boolean(row?.role && row.role !== "orchestrator")
  } catch {
    return false
  } finally {
    db?.close()
  }
}

function bindingStateDb(directory: string, projectContext?: MotryxProjectContext) {
  const sessionID = requestedOrchestratorSessionID(projectContext)
  if (!sessionID || sessionID.startsWith("@")) return undefined
  const channelDb = projectContext?.channelDbPath
    || process.env.MOTRYX_CHANNEL_DB
    || path.join(path.resolve(directory), ".motryx", "db", "channel.db")
  if (!existsSync(channelDb)) return undefined
  let db: Database | undefined
  try {
    db = new Database(channelDb, { readonly: true })
    const row = db.query<{ icAgentDbPath: string }, [string, string]>(`
      select ic_agent_db_path as icAgentDbPath
        from orchestrator_bindings
       where project_id = ?
         and orchestrator_session_id = ?
    `).get(projectContext?.projectDir ?? path.resolve(directory), sessionID)
    return row?.icAgentDbPath ? path.resolve(row.icAgentDbPath) : undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function classifyStateDbSource(
  stateDb: string,
  directory: string,
  projectContext?: MotryxProjectContext,
): NonNullable<IcWorkflowSnapshot["stateDbSource"]> {
  const resolved = path.resolve(stateDb)
  const requestedSessionID = requestedOrchestratorSessionID(projectContext)
  const bound = requestedSessionID && !requestedSessionID.startsWith("@") ? bindingStateDb(directory, projectContext) : undefined
  if (bound && path.resolve(bound) === resolved) {
    return {
      kind: "orchestrator-binding",
      productTruth: true,
      legacy: false,
      detail: "Selected by orchestrator binding from channel.db.",
    }
  }

  if (projectContext?.currentIcAgentDbPath && path.resolve(projectContext.currentIcAgentDbPath) === resolved) {
    return {
      kind: projectContext.bindingStatus === "explicit-ic-agent-db" ? "explicit-ic-agent-db" : "orchestrator-binding",
      productTruth: projectContext.bindingStatus !== "explicit-ic-agent-db",
      legacy: false,
      detail: projectContext.bindingStatus === "explicit-ic-agent-db"
        ? "Selected by explicit IC Agent DB override from Motryx project context."
        : "Selected by current Motryx project context.",
    }
  }

  const explicit = process.env.MOTRYX_IC_AGENT_DB_PATH || process.env.IC_AGENT_DB_PATH
  if (explicit && path.resolve(explicit) === resolved) {
    return {
      kind: "explicit-ic-agent-db",
      productTruth: false,
      legacy: false,
      detail: "Selected by explicit IC Agent DB override.",
    }
  }

  if (requestedSessionID && dbContainsInternalSession(resolved, requestedSessionID)) {
    return {
      kind: "internal-agent-owner",
      productTruth: true,
      legacy: false,
      detail: "Selected the owning orchestrator DB for an internal debug agent session.",
    }
  }

  const ancestors = ancestorDirectories(directory)
  for (const item of ancestors) {
    const orchestratorRoot = path.join(item, ".motryx", "db", "orchestrators")
    if (isPathInside(resolved, orchestratorRoot)) {
      return {
        kind: "orchestrator-latest",
        productTruth: true,
        legacy: false,
        detail: "Selected from project-local Motryx orchestrator DBs without an explicit orchestrator.",
      }
    }
  }
  for (const item of ancestors) {
    if (resolved === path.resolve(item, ".ic-agent", "state.db")) {
      return {
        kind: "legacy-project-state",
        productTruth: false,
        legacy: true,
        detail: "Legacy .ic-agent/state.db fallback for debug/import only.",
      }
    }
  }
  for (const item of ancestors) {
    const regressionRoot = path.join(item, "regression", "runs")
    if (isPathInside(resolved, regressionRoot) && resolved.endsWith(path.join(".ic-agent", "state.db"))) {
      return {
        kind: "legacy-regression-run",
        productTruth: false,
        legacy: true,
        detail: "Legacy regression run state DB fallback for debug/import only.",
      }
    }
  }
  return {
    kind: "unknown-state-db",
    productTruth: false,
    legacy: false,
    detail: "Selected by fallback scan.",
  }
}

function requestedOrchestratorSessionID(projectContext?: MotryxProjectContext) {
  if (projectContext) return projectContext.currentOrchestratorSessionID || ""
  return process.env.MOTRYX_ORCHESTRATOR_SESSION_ID || process.env.MOTRYX_RESUME_SESSION || ""
}

function projectContextDiagnostics(projectContext?: MotryxProjectContext): IcWorkflowSnapshot["diagnostics"] {
  if (!projectContext) return []
  if (projectContext.bindingStatus === "missing-binding") {
    return [{
      id: "motryx-binding-missing",
      severity: "warn",
      title: "Motryx orchestrator binding missing",
      detail: `No channel.db binding for orchestrator session ${projectContext.currentOrchestratorSessionID}.`,
      source: "motryx.project_context",
      targetType: "runtime",
      targetID: "orchestrator-binding",
      recommendation: "Resume or repair this Motryx orchestrator binding before relying on workflow state.",
      evidence: projectContext.channelDbPath,
      readonly: true,
      sessionID: projectContext.currentOrchestratorSessionID,
    }]
  }
  if (projectContext.bindingStatus === "bound" && projectContext.currentIcAgentDbPath && !existsSync(projectContext.currentIcAgentDbPath)) {
    return [{
      id: "ic-agent-db-missing",
      severity: "warn",
      title: "Motryx IC Agent DB missing",
      detail: "The current orchestrator binding points to an IC Agent DB that does not exist.",
      source: "motryx.project_context",
      targetType: "runtime",
      targetID: "ic-agent-db",
      recommendation: "Run motryx migrate or repair this orchestrator binding.",
      evidence: projectContext.currentIcAgentDbPath,
      readonly: true,
      sessionID: projectContext.currentOrchestratorSessionID,
    }]
  }
  if (projectContext.bindingStatus === "alias-unresolved") {
    return [{
      id: "motryx-session-alias-unresolved",
      severity: "info",
      title: "Motryx session alias unresolved",
      detail: "The TUI has not resolved the requested @N alias to an orchestrator session id yet.",
      source: "motryx.project_context",
      targetType: "session",
      targetID: "orchestrator",
      recommendation: "Resolve the session alias before loading workflow state.",
      evidence: projectContext.motryxSessionDbPath,
      readonly: true,
    }]
  }
  return []
}

function isPathInside(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function ancestorDirectories(directory: string) {
  const result: string[] = []
  let current = path.resolve(directory || process.cwd())
  while (true) {
    result.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}

function first<Row extends object>(db: Database, sql: string): Row | undefined {
  try {
    return db.query<Row, []>(sql).get() ?? undefined
  } catch {
    return undefined
  }
}

function all<Row extends object>(db: Database, sql: string): Row[] {
  try {
    return db.query<Row, []>(sql).all()
  } catch {
    return []
  }
}

function count(db: Database, sql: string) {
  try {
    return Number(db.query<{ count: number }, []>(sql).get()?.count ?? 0)
  } catch {
    return 0
  }
}

function tableExists(db: Database, table: string) {
  try {
    return Boolean(db.query<{ name: string }, [string]>(
      "select name from sqlite_master where type = 'table' and name = ?",
    ).get(table))
  } catch {
    return false
  }
}

function icAgentSchemaStale(db: Database) {
  try {
    const table = db.query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name = 'schema_migrations'",
    ).get()
    if (!table) return true
    const row = db.query<{ version: string }, [string]>(
      "select version from schema_migrations where version = ?",
    ).get(REQUIRED_IC_AGENT_MIGRATION)
    return !row
  } catch {
    return true
  }
}

function hasColumn(db: Database, table: string, column: string) {
  try {
    return db.query<{ name: string }, []>(`pragma table_info(${table})`).all().some((item) => item.name === column)
  } catch {
    return false
  }
}

function parseStringArray(value: string | undefined) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function normalizeSeverity(value: unknown): IcWorkflowSnapshot["diagnostics"][number]["severity"] {
  return value === "error" || value === "warn" || value === "info" ? value : "info"
}

function normalizeTargetType(value: unknown): IcWorkflowSnapshot["diagnostics"][number]["targetType"] {
  switch (value) {
    case "workflow":
    case "lane":
    case "agent":
    case "session":
    case "message":
    case "outbox":
    case "wake":
    case "runtime":
      return value
    default:
      return "runtime"
  }
}

function laneAssignments(db: Database) {
  return all<LaneOwnerRow>(
    db,
    `select la.lane_id as laneID,
            la.instance_id as instanceID,
            la.role as role,
            ai.session_id as sessionID
       from lane_assignments la
       join agent_instances ai on ai.instance_id = la.instance_id
      where la.status = 'ACTIVE'
        and la.role in ('coordinator', 'checker')`,
  )
}

function laneOwnerMap(rows: LaneOwnerRow[]) {
  const owners = new Map<string, { coordinatorSessionID?: string; checkerSessionID?: string }>()
  rows.forEach((row) => {
    if (!row.sessionID) return
    const owner = owners.get(row.laneID) ?? {}
    if (row.role === "coordinator") owner.coordinatorSessionID = row.sessionID
    if (row.role === "checker") owner.checkerSessionID = row.sessionID
    owners.set(row.laneID, owner)
  })
  return owners
}

function agentLaneMap(rows: LaneOwnerRow[]) {
  const agents = new Map<string, string[]>()
  rows.forEach((row) => {
    const lanes = agents.get(row.instanceID) ?? []
    if (!lanes.includes(row.laneID)) lanes.push(row.laneID)
    agents.set(row.instanceID, lanes)
  })
  return agents
}

type WorkflowRow = {
  id: string
  status: string
  goal: string
}

type LaneRow = {
  id: string
  name: string
  status: string
  updatedAt?: string
  lastCheckResult?: string
  pendingCheckSummary?: string
  reopenCount?: number
  repairCycle?: number
  dependsOnLaneIDsJson?: string
}

type LaneOwnerRow = {
  laneID: string
  instanceID: string
  role: string
  sessionID: string
}

type AgentRow = {
  instanceID: string
  role: string
  sessionID: string
  orchestratorSessionID?: string | null
  status: string
}
