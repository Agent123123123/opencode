import path from "node:path"

export const MOTRYX_CONTROL_SCHEMA_VERSION = 6 as const

export type MotryxControlConfig = {
  apiURL: string
  token: string
  projectID: string
  orchestratorSessionID: string
}

export type MotryxFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type MotryxRuntimeHealthWarning = {
  warningID: string
  kind: "ROUTE_HEALTH_UNCONFIRMED"
  scope: "SESSION"
  components: Array<"OPEN_CODE" | "SIDECAR">
  firstObservedAt: string
  lastObservedAt: string
  safeSummary: string
  httpStatus?: number
  transportCode?: string
  dismissible: true
}

export type MotryxControlHealth = {
  schemaVersion: typeof MOTRYX_CONTROL_SCHEMA_VERSION
  status: "ok" | "switching" | "starting"
  projectID: string
  serverGeneration: string
  orchestratorSessionID: string
  runtimeWarnings: MotryxRuntimeHealthWarning[]
}

export type MotryxSessionRoute = {
  sessionID: string
  serverGeneration: string
  bindingGeneration: number
  ownerRunID: string
}

export type MotryxSessionListItem = {
  sessionID: string
  title: string
  lastRoutedAt: string | null
  state: "CURRENT" | "RESUMABLE" | "UNAVAILABLE"
  unavailableReason?: string
}

export type MotryxSessionTransition = {
  state: "SWITCHING" | "FAILED"
  switchID: string
  fromSessionID: string
  targetSessionID: string
  phase: string
  startedAt: string | null
  message?: string
}

export type MotryxSessionList = {
  schemaVersion: typeof MOTRYX_CONTROL_SCHEMA_VERSION
  projectID: string
  status: "ROUTABLE" | "SWITCHING" | "UNAVAILABLE"
  current: MotryxSessionRoute | null
  transition: MotryxSessionTransition | null
  sessions: MotryxSessionListItem[]
}

export type MotryxRouteProof = {
  state: "ROUTABLE"
  serverGeneration: string
  sidecarGeneration: string
  bindingGeneration: number
  reconciledThrough: {
    sessionID: string
    seq: number | null
    eventID: string | null
  }
  observedAt: string
}

export type MotryxBindingProof = {
  projectID: string
  orchestratorSessionID: string
  runtimeID: string
  bindingState: "ACTIVE"
  bindingGeneration: number
  ownerRunID: string
  createdAt: string
  updatedAt: string
  activatedAt: string
  lastRoutedAt: string | null
}

export type MotryxWorkflowProjection = {
  id: string
  status: string
  goal: string
}

export type MotryxCapacityProjection = {
  maxConcurrentLanes: number
  activeLaneIDs: string[]
  activeCount: number
  available: number | null
  capacityReached: boolean
  readyLaneIDs: string[]
}

export type MotryxRuntimeTargetProjection = {
  slotID: string
  instanceID: string
  sessionID: string
}

export type MotryxLaneProjection = {
  id: string
  name: string
  status: string
  updatedAt: string
  lastCheckResult?: string
  pendingCheckSummary?: string
  reopenCount: number
  repairCycle: number
  dependsOnLaneIDs: string[]
  coordinatorSlotID?: string
  checkerSlotID?: string
  coordinatorRuntimeReadiness: string
  checkerRuntimeReadiness: string
  coordinatorRuntime?: MotryxRuntimeTargetProjection
  checkerRuntime?: MotryxRuntimeTargetProjection
  schedulingPhase?: "READY" | "PREPARING"
  runPhase?: "EXECUTING" | "WAITING_RESPONSE" | "RESUME_QUEUED"
  requestMessageID?: string
  requestDeadlineAt?: number
  failure?: MotryxLaneFailureProjection
}

export type MotryxLaneFailureProjection = {
  incidentID: string
  role: "coordinator" | "checker"
  kind: string
  safeSummary: string
  openedAt: number
  presentationState: "VISIBLE" | "DISMISSED"
}

export type MotryxRuntimeIncidentProjection = {
  incidentID: string
  scopeKind: "LANE" | "SESSION"
  laneID?: string
  role: string
  failedPhase: string
  failureKind: string
  status: "OPEN" | "RESOLVED"
  presentationState: "VISIBLE" | "DISMISSED"
  safeSummary: string
  instanceID?: string
  sessionID?: string
  turnID?: string
  providerID?: string
  modelID?: string
  httpStatus?: number
  transportKind?: string
  transportCode?: string
  retryable?: boolean
  retryExhausted?: boolean
  attemptCount?: number
  runID?: string
  attemptID?: string
  proofRef?: string
  occurrenceCount: number
  openedAt: number
  lastSeenAt: number
  resolvedAt?: number
}

export type MotryxAgentProjection = {
  instanceID: string
  role: string
  sessionID: string
  orchestratorSessionID?: string
  status: string
  laneIDs: string[]
}

export type MotryxArtifactProjection = {
  id: string
  workflowID: string
  producedByLaneID: string
  kind: string
  title: string
  path: string
  locatorRef: string
  version: number
  status: string
  snapshotError?: string
  detail: string
  mtime: number
}

export type MotryxFunctionSlotProjection = {
  slotID: string
  slotKey: string
  role: string
  runtimeReadiness: string
}

export type MotryxRunProjection = {
  runID: string
  workflowID?: string
  scopeKind: "LANE_PRIMARY" | "SLOT_INPUT" | "SESSION_INPUT"
  runKind: "COORDINATOR" | "CHECKER" | "LANE_DECISION" | "ORCHESTRATOR_TURN" | "ANALYST_ADVISORY" | "A2A_RESPONDER" | "NOTIFICATION"
  status: "OPEN" | "WAITING" | "SUCCEEDED" | "FAILED" | "CANCELED"
  laneID?: string
  relatedLaneID?: string
  logicalOwnerKind: "FUNCTION_SLOT" | "CONTROL_ROLE"
  logicalOwnerID: string
  waitingKind?: "a2a_request" | "attention" | "runtime_repair" | "reconciliation" | "user_paused" | "runtime_restart"
  waitingRef?: string
  sourceKind: string
  sourceID: string
  revision: number
  errorRetryCount: number
  maxErrorRetries: number
  protocolCorrectionCount: number
  maxProtocolCorrections: number
  retryNotBefore?: number
  retryDisposition?: "ALLOWED_AFTER_REPAIR" | "RECONCILIATION_REQUIRED" | "FORBIDDEN"
  resultRef?: string
  failureRef?: string
  createdAt: number
  terminalAt?: number
  currentAttemptID?: string
}

export type MotryxAttemptProjection = {
  attemptID: string
  runID: string
  attemptNo: number
  reason: "INITIAL" | "ERROR_RETRY" | "PROTOCOL_CORRECTION" | "WAIT_RESUME"
  instanceID: string
  sessionID: string
  stableInputID: string
  state: "PENDING" | "RUNNING" | "OUTCOME_UNKNOWN" | "TERMINAL"
  submitCount: number
  createdAt: number
  dispatchNotBefore?: number
  lastSubmitError?: string
  turnID?: string
  startedAt?: number
  terminalKind?: "NOT_STARTED" | "COMPLETED" | "FAILED" | "INTERRUPTED" | "PROCESS_LOST" | "CANCELED_BEFORE_START"
  terminalProofRef?: string
  terminalAt?: number
  inputVisibility?: "NOT_ADMITTED" | "ADMITTED_UNPROMOTED" | "PROMOTED_TRANSCRIPT_VISIBLE"
  failureKind?: string
  failureSafeSummary?: string
  providerID?: string
  modelID?: string
  httpStatus?: number
  transportKind?: string
  transportCode?: string
  hostRetryable?: boolean
  hostRetryExhausted?: boolean
  hostAttemptCount?: number
  cancelOrigin?: "USER" | "FRAMEWORK" | "SHUTDOWN" | "STALE" | "BUSINESS"
  cancelReason?: string
  cancelRequestedAt?: number
}

export type MotryxAttentionKind =
  | "PROVIDER_RETRY"
  | "RUN_RETRY_SCHEDULED"
  | "RUN_RETRY_RUNNING"
  | "PROTOCOL_CORRECTION"
  | "DELIVERY_RETRY"
  | "OUTCOME_UNKNOWN"
  | "WAITING_ATTENTION"
  | "WAITING_RUNTIME_REPAIR"
  | "WAITING_RECONCILIATION"
  | "USER_PAUSED"
  | "RUNTIME_RESTART"
  | "FINAL_FAILURE"

export type MotryxAttentionItemProjection = {
  attentionID: string
  kind: MotryxAttentionKind
  severity: "INFO" | "WARNING" | "ERROR"
  scopeKind: "LANE" | "SESSION"
  role: string
  laneID?: string
  runID?: string
  attemptID?: string
  incidentID?: string
  summary: string
  reasonCode?: string
  nextAction?: string
  dismissible: boolean
  presentationState: "VISIBLE" | "DISMISSED"
  createdAt: number
  actionRequired: boolean
  retryLayer?: "PROVIDER" | "DELIVERY" | "RUN" | "PROTOCOL"
  retryAttempt?: number
  retryLimit?: number
  retryNotBefore?: number
  failureKind?: string
  httpStatus?: number
  transportKind?: string
  transportCode?: string
  providerID?: string
  modelID?: string
}

export type MotryxControlSnapshot = {
  schemaVersion: typeof MOTRYX_CONTROL_SCHEMA_VERSION
  projectID: string
  orchestratorSessionID: string
  projectionRevision: string
  route: MotryxRouteProof
  binding: MotryxBindingProof
  workflow?: MotryxWorkflowProjection
  capacity: MotryxCapacityProjection
  lanes: MotryxLaneProjection[]
  agents: MotryxAgentProjection[]
  artifacts: MotryxArtifactProjection[]
  resourceBlocks: Record<string, unknown>[]
  incidents: MotryxRuntimeIncidentProjection[]
  attentionItems: MotryxAttentionItemProjection[]
  attention: {
    visibleOpenIncidentCount: number
    failedLaneCount: number
    activeAttentionCount: number
    userActionRequiredCount: number
    retryingCount: number
  }
  functionSlots: MotryxFunctionSlotProjection[]
  runs: MotryxRunProjection[]
  attempts: MotryxAttemptProjection[]
  diagnostics: Record<string, unknown>[]
  runtimeWarnings: MotryxRuntimeHealthWarning[]
}

export class MotryxControlHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "MotryxControlHttpError"
    this.status = status
  }
}

export class MotryxControlSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MotryxControlSchemaError"
  }
}

export function motryxControlConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { ok: true; value: MotryxControlConfig } | { ok: false; error: string } {
  const apiURL = env.MOTRYX_CONTROL_API_URL?.trim()
  const token = env.MOTRYX_CONTROL_API_TOKEN?.trim()
  const project = env.MOTRYX_PROJECT_DIR?.trim()
  const session = env.MOTRYX_ORCHESTRATOR_SESSION_ID?.trim()
  if (!apiURL) return { ok: false, error: "MOTRYX_CONTROL_API_URL is missing" }
  if (!token) return { ok: false, error: "MOTRYX_CONTROL_API_TOKEN is missing" }
  if (!project) return { ok: false, error: "MOTRYX_PROJECT_DIR is missing" }
  if (!session) return { ok: false, error: "MOTRYX_ORCHESTRATOR_SESSION_ID is missing" }
  try {
    const url = new URL(apiURL)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "Motryx control API must use http or https" }
    }
    return {
      ok: true,
      value: {
        apiURL: url.toString(),
        token,
        projectID: path.resolve(project),
        orchestratorSessionID: session,
      },
    }
  } catch {
    return { ok: false, error: "MOTRYX_CONTROL_API_URL is invalid" }
  }
}

export function motryxControlURL(config: MotryxControlConfig, endpoint: "workflow" | "events" | "health") {
  const url = new URL(
    endpoint === "workflow" ? "/ic/workflow" : endpoint === "events" ? "/ic/events" : "/ic/health",
    config.apiURL,
  )
  if (endpoint !== "health") url.searchParams.set("orchestrator_session_id", config.orchestratorSessionID)
  return url
}

export async function fetchMotryxControlHealth(
  config: MotryxControlConfig,
  options: { signal?: AbortSignal; fetcher?: MotryxFetcher } = {},
): Promise<MotryxControlHealth> {
  const response = await (options.fetcher ?? fetch)(motryxControlURL(config, "health"), {
    signal: options.signal,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
    },
  })
  if (!response.ok) {
    throw new MotryxControlHttpError(response.status, `Motryx control health returned HTTP ${response.status}`)
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new MotryxControlSchemaError("Motryx control health did not return JSON")
  }
  const root = requiredRecord(await response.json(), "health")
  if (root.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION) fail("health.schemaVersion must be 6")
  if (root.status !== "ok" && root.status !== "switching" && root.status !== "starting") {
    fail("health.status is invalid")
  }
  return {
    schemaVersion: MOTRYX_CONTROL_SCHEMA_VERSION,
    status: root.status,
    projectID: exactProject(root.projectID, config.projectID, "health.projectID"),
    serverGeneration: requiredString(root.serverGeneration, "health.serverGeneration"),
    orchestratorSessionID: exactString(
      root.orchestratorSessionID,
      config.orchestratorSessionID,
      "health.orchestratorSessionID",
    ),
    runtimeWarnings: parseMotryxRuntimeHealthWarnings(root.runtimeWarnings, "health.runtimeWarnings"),
  }
}

export function motryxSessionsURL(config: MotryxControlConfig, endpoint: "list" | "switch" = "list") {
  return new URL(endpoint === "list" ? "/ic/sessions" : "/ic/sessions/switch", config.apiURL)
}

export async function fetchMotryxSessions(
  config: MotryxControlConfig,
  options: { signal?: AbortSignal; fetcher?: MotryxFetcher } = {},
): Promise<MotryxSessionList> {
  const response = await (options.fetcher ?? fetch)(motryxSessionsURL(config), {
    signal: options.signal,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
    },
  })
  return parseSessionListResponse(response, config)
}

export async function switchMotryxSession(
  config: MotryxControlConfig,
  input: { targetSessionID: string; expected: MotryxSessionRoute },
  options: { signal?: AbortSignal; fetcher?: MotryxFetcher } = {},
): Promise<MotryxSessionList> {
  const response = await (options.fetcher ?? fetch)(motryxSessionsURL(config, "switch"), {
    method: "POST",
    signal: options.signal,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      targetSessionID: input.targetSessionID,
      expected: {
        serverGeneration: input.expected.serverGeneration,
        currentSessionID: input.expected.sessionID,
        bindingGeneration: input.expected.bindingGeneration,
        ownerRunID: input.expected.ownerRunID,
      },
    }),
  })
  const result = await parseSessionListResponse(response, config)
  if (result.status !== "ROUTABLE" || result.current?.sessionID !== input.targetSessionID) {
    throw new MotryxControlSchemaError("Motryx session switch did not return the exact routed target")
  }
  return result
}

async function parseSessionListResponse(response: Response, config: MotryxControlConfig) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  let value: unknown
  if (contentType.includes("application/json")) {
    try {
      value = await response.json()
    } catch {
      throw new MotryxControlSchemaError("Motryx sessions response contains invalid JSON")
    }
  }
  if (!response.ok) {
    const item = isRecord(value) ? value : {}
    const detail = typeof item.message === "string" && item.message ? `: ${item.message}` : ""
    throw new MotryxControlHttpError(response.status, `Motryx sessions returned HTTP ${response.status}${detail}`)
  }
  if (!contentType.includes("application/json")) {
    throw new MotryxControlSchemaError("Motryx sessions did not return JSON")
  }
  return parseMotryxSessionList(value, config)
}

export function parseMotryxSessionList(value: unknown, expected: MotryxControlConfig): MotryxSessionList {
  const root = requiredRecord(value, "sessions")
  if (root.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION) fail("sessions.schemaVersion must be 6")
  const projectID = exactProject(root.projectID, expected.projectID, "sessions.projectID")
  if (root.status !== "ROUTABLE" && root.status !== "SWITCHING" && root.status !== "UNAVAILABLE") {
    fail("sessions.status is invalid")
  }
  const current = root.current === null ? null : parseSessionRoute(root.current)
  if (root.status === "ROUTABLE" && current === null) fail("sessions.current is required while ROUTABLE")
  if (root.status !== "ROUTABLE" && current !== null) fail("sessions.current must be null while not ROUTABLE")
  const transition = root.transition === null ? null : parseSessionTransition(root.transition)
  const sessions = requiredArray(root.sessions, "sessions.sessions", parseSessionListItem)
  const currentItems = sessions.filter((item) => item.state === "CURRENT")
  if (current) {
    if (currentItems.length !== 1 || currentItems[0]?.sessionID !== current.sessionID) {
      fail("sessions current item does not match the exact current route")
    }
  } else if (currentItems.length !== 0) {
    fail("sessions must not claim a CURRENT item while unbound")
  }
  return {
    schemaVersion: MOTRYX_CONTROL_SCHEMA_VERSION,
    projectID,
    status: root.status,
    current,
    transition,
    sessions,
  } as MotryxSessionList
}

function parseSessionRoute(value: unknown): MotryxSessionRoute {
  const item = requiredRecord(value, "sessions.current")
  return {
    sessionID: requiredString(item.sessionID, "sessions.current.sessionID"),
    serverGeneration: requiredString(item.serverGeneration, "sessions.current.serverGeneration"),
    bindingGeneration: positiveInteger(item.bindingGeneration, "sessions.current.bindingGeneration"),
    ownerRunID: requiredString(item.ownerRunID, "sessions.current.ownerRunID"),
  }
}

function parseSessionTransition(value: unknown): MotryxSessionTransition {
  const item = requiredRecord(value, "sessions.transition")
  if (item.state !== "SWITCHING" && item.state !== "FAILED") fail("sessions.transition.state is invalid")
  const startedAt = item.startedAt
  if (startedAt !== null) timestamp(startedAt, "sessions.transition.startedAt")
  return {
    state: item.state,
    switchID: requiredString(item.switchID, "sessions.transition.switchID"),
    fromSessionID: requiredString(item.fromSessionID, "sessions.transition.fromSessionID"),
    targetSessionID: requiredString(item.targetSessionID, "sessions.transition.targetSessionID"),
    phase: requiredString(item.phase, "sessions.transition.phase"),
    startedAt: typeof startedAt === "string" ? startedAt : null,
    ...(typeof item.message === "string" && item.message ? { message: item.message } : {}),
  }
}

function parseSessionListItem(value: unknown, label: string): MotryxSessionListItem {
  const item = requiredRecord(value, label)
  if (item.state !== "CURRENT" && item.state !== "RESUMABLE" && item.state !== "UNAVAILABLE") {
    fail(`${label}.state is invalid`)
  }
  const lastRoutedAt = item.lastRoutedAt
  if (lastRoutedAt !== null) timestamp(lastRoutedAt, `${label}.lastRoutedAt`)
  return {
    sessionID: requiredString(item.sessionID, `${label}.sessionID`),
    title: requiredString(item.title, `${label}.title`),
    lastRoutedAt: typeof lastRoutedAt === "string" ? lastRoutedAt : null,
    state: item.state,
    ...(typeof item.unavailableReason === "string" && item.unavailableReason
      ? { unavailableReason: item.unavailableReason }
      : {}),
  }
}

export async function fetchMotryxControlSnapshot(
  config: MotryxControlConfig,
  options: { signal?: AbortSignal; fetcher?: MotryxFetcher } = {},
): Promise<MotryxControlSnapshot> {
  const response = await (options.fetcher ?? fetch)(motryxControlURL(config, "workflow"), {
    signal: options.signal,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.token}`,
    },
  })
  if (!response.ok) {
    throw new MotryxControlHttpError(response.status, `Motryx control snapshot returned HTTP ${response.status}`)
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    throw new MotryxControlSchemaError("Motryx control snapshot did not return JSON")
  }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new MotryxControlSchemaError("Motryx control snapshot contains invalid JSON")
  }
  return parseMotryxControlSnapshot(value, config)
}

export async function dismissMotryxIncident(
  config: MotryxControlConfig,
  input: { incidentID: string; snapshot: MotryxControlSnapshot },
  options: { signal?: AbortSignal; fetcher?: MotryxFetcher } = {},
): Promise<{ incidentID: string; status: string; presentationState: "DISMISSED"; dismissedAt: number }> {
  const url = new URL(`/ic/incidents/${encodeURIComponent(input.incidentID)}/dismiss`, config.apiURL)
  const response = await (options.fetcher ?? fetch)(url, {
    method: "POST",
    signal: options.signal,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      orchestratorSessionID: config.orchestratorSessionID,
      expectedServerGeneration: input.snapshot.route.serverGeneration,
      expectedBindingGeneration: input.snapshot.binding.bindingGeneration,
      expectedProjectionRevision: input.snapshot.projectionRevision,
    }),
  })
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new MotryxControlSchemaError("Motryx incident dismissal response contains invalid JSON")
  }
  if (!response.ok) {
    const detail = isRecord(value) && typeof value.message === "string" ? `: ${value.message}` : ""
    throw new MotryxControlHttpError(response.status, `Motryx incident dismissal returned HTTP ${response.status}${detail}`)
  }
  const result = requiredRecord(value, "incident dismissal")
  if (result.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION) fail("incident dismissal schemaVersion must be 6")
  if (result.incidentID !== input.incidentID) fail("incident dismissal returned a different incident")
  if (result.presentationState !== "DISMISSED") fail("incident dismissal did not persist DISMISSED")
  return {
    incidentID: input.incidentID,
    status: requiredString(result.status, "incident dismissal.status"),
    presentationState: "DISMISSED",
    dismissedAt: finiteNumber(result.dismissedAt, "incident dismissal.dismissedAt"),
  }
}

export function parseMotryxControlSnapshot(value: unknown, expected: MotryxControlConfig): MotryxControlSnapshot {
  const root = requiredRecord(value, "snapshot")
  if (root.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION) fail("snapshot.schemaVersion must be 6")
  const projectID = exactProject(root.projectID, expected.projectID, "snapshot.projectID")
  const orchestratorSessionID = exactString(
    root.orchestratorSessionID,
    expected.orchestratorSessionID,
    "snapshot.orchestratorSessionID",
  )
  const projectionRevision = requiredString(root.projectionRevision, "snapshot.projectionRevision")
  const route = parseRoute(root.route, expected)
  const binding = parseBinding(root.binding, expected)
  if (route.bindingGeneration !== binding.bindingGeneration) {
    fail("route and binding generation do not match")
  }
  if (route.serverGeneration !== route.sidecarGeneration) {
    fail("route server and sidecar generation do not match")
  }
  if (!projectionRevision.startsWith(`${route.serverGeneration}:`)) {
    fail("projection revision is not scoped to the routed server generation")
  }

  return {
    schemaVersion: MOTRYX_CONTROL_SCHEMA_VERSION,
    projectID,
    orchestratorSessionID,
    projectionRevision,
    route,
    binding,
    workflow: root.workflow === undefined ? undefined : parseWorkflow(root.workflow),
    capacity: parseCapacity(root.capacity),
    lanes: requiredArray(root.lanes, "snapshot.lanes", parseLane),
    agents: requiredArray(root.agents, "snapshot.agents", parseAgent),
    artifacts: requiredArray(root.artifacts, "snapshot.artifacts", parseArtifact),
    resourceBlocks: requiredArray(root.resourceBlocks, "snapshot.resourceBlocks", (item, label) =>
      requiredRecord(item, label),
    ),
    incidents: requiredArray(root.incidents, "snapshot.incidents", parseRuntimeIncident),
    attentionItems: requiredArray(root.attentionItems, "snapshot.attentionItems", parseAttentionItem),
    attention: parseAttention(root.attention),
    functionSlots: requiredArray(root.functionSlots, "snapshot.functionSlots", parseFunctionSlot),
    runs: requiredArray(root.runs, "snapshot.runs", parseRun),
    attempts: requiredArray(root.attempts, "snapshot.attempts", parseAttempt),
    diagnostics: requiredArray(root.diagnostics, "snapshot.diagnostics", (item, label) => requiredRecord(item, label)),
    runtimeWarnings: parseMotryxRuntimeHealthWarnings(root.runtimeWarnings, "snapshot.runtimeWarnings"),
  }
}

export function parseMotryxRuntimeHealthWarnings(value: unknown, label = "runtimeWarnings") {
  return requiredArray(value, label, parseRuntimeHealthWarning)
}

function parseRuntimeHealthWarning(value: unknown, label: string): MotryxRuntimeHealthWarning {
  const item = requiredRecord(value, label)
  if (item.kind !== "ROUTE_HEALTH_UNCONFIRMED") fail(`${label}.kind is invalid`)
  if (item.scope !== "SESSION") fail(`${label}.scope is invalid`)
  if (item.dismissible !== true) fail(`${label}.dismissible must be true`)
  const components = stringArray(item.components, `${label}.components`)
  if (components.some((component) => component !== "OPEN_CODE" && component !== "SIDECAR")) {
    fail(`${label}.components contains an invalid component`)
  }
  const httpStatus = item.httpStatus
  if (httpStatus !== undefined && (!Number.isInteger(httpStatus) || (httpStatus as number) < 100)) {
    fail(`${label}.httpStatus is invalid`)
  }
  return compact({
    warningID: requiredString(item.warningID, `${label}.warningID`),
    kind: "ROUTE_HEALTH_UNCONFIRMED",
    scope: "SESSION",
    components: components as Array<"OPEN_CODE" | "SIDECAR">,
    firstObservedAt: timestamp(item.firstObservedAt, `${label}.firstObservedAt`),
    lastObservedAt: timestamp(item.lastObservedAt, `${label}.lastObservedAt`),
    safeSummary: requiredString(item.safeSummary, `${label}.safeSummary`),
    httpStatus: httpStatus as number | undefined,
    transportCode: optionalString(item.transportCode, `${label}.transportCode`),
    dismissible: true,
  })
}

function parseRoute(value: unknown, expected: MotryxControlConfig): MotryxRouteProof {
  const route = requiredRecord(value, "snapshot.route")
  if (route.state !== "ROUTABLE") fail("snapshot.route.state must be ROUTABLE")
  const reconciled = requiredRecord(route.reconciledThrough, "snapshot.route.reconciledThrough")
  const sessionID = exactString(
    reconciled.sessionID,
    expected.orchestratorSessionID,
    "snapshot.route.reconciledThrough.sessionID",
  )
  const seq = reconciled.seq
  if (seq !== null && (!Number.isInteger(seq) || (seq as number) < 0)) {
    fail("snapshot.route.reconciledThrough.seq must be null or a non-negative integer")
  }
  const eventID = reconciled.eventID
  if (seq === null) {
    if (eventID !== null && eventID !== undefined) {
      fail("snapshot.route.reconciledThrough.eventID must be null when seq is null")
    }
  } else if (typeof eventID !== "string" || !eventID) {
    fail("snapshot.route.reconciledThrough.eventID is required when seq is present")
  }
  return {
    state: "ROUTABLE",
    serverGeneration: requiredString(route.serverGeneration, "snapshot.route.serverGeneration"),
    sidecarGeneration: requiredString(route.sidecarGeneration, "snapshot.route.sidecarGeneration"),
    bindingGeneration: positiveInteger(route.bindingGeneration, "snapshot.route.bindingGeneration"),
    reconciledThrough: {
      sessionID,
      seq: seq as number | null,
      eventID: typeof eventID === "string" ? eventID : null,
    },
    observedAt: timestamp(route.observedAt, "snapshot.route.observedAt"),
  }
}

function parseBinding(value: unknown, expected: MotryxControlConfig): MotryxBindingProof {
  const binding = requiredRecord(value, "snapshot.binding")
  if (binding.bindingState !== "ACTIVE") fail("snapshot.binding.bindingState must be ACTIVE")
  const lastRoutedAt = binding.lastRoutedAt
  if (lastRoutedAt !== null && lastRoutedAt !== undefined) timestamp(lastRoutedAt, "snapshot.binding.lastRoutedAt")
  return {
    projectID: exactProject(binding.projectID, expected.projectID, "snapshot.binding.projectID"),
    orchestratorSessionID: exactString(
      binding.orchestratorSessionID,
      expected.orchestratorSessionID,
      "snapshot.binding.orchestratorSessionID",
    ),
    runtimeID: requiredString(binding.runtimeID, "snapshot.binding.runtimeID"),
    bindingState: "ACTIVE",
    bindingGeneration: positiveInteger(binding.bindingGeneration, "snapshot.binding.bindingGeneration"),
    ownerRunID: requiredString(binding.ownerRunID, "snapshot.binding.ownerRunID"),
    createdAt: timestamp(binding.createdAt, "snapshot.binding.createdAt"),
    updatedAt: timestamp(binding.updatedAt, "snapshot.binding.updatedAt"),
    activatedAt: timestamp(binding.activatedAt, "snapshot.binding.activatedAt"),
    lastRoutedAt: typeof lastRoutedAt === "string" ? lastRoutedAt : null,
  }
}

function parseWorkflow(value: unknown): MotryxWorkflowProjection {
  const item = requiredRecord(value, "snapshot.workflow")
  return {
    id: requiredString(item.id, "snapshot.workflow.id"),
    status: requiredString(item.status, "snapshot.workflow.status"),
    goal: requiredString(item.goal, "snapshot.workflow.goal", true),
  }
}

function parseCapacity(value: unknown): MotryxCapacityProjection {
  const item = requiredRecord(value, "snapshot.capacity")
  const maxConcurrentLanes = nonNegativeInteger(item.maxConcurrentLanes, "snapshot.capacity.maxConcurrentLanes")
  const activeLaneIDs = stringArray(item.activeLaneIDs, "snapshot.capacity.activeLaneIDs")
  const activeCount = nonNegativeInteger(item.activeCount, "snapshot.capacity.activeCount")
  const available = item.available === null
    ? null
    : nonNegativeInteger(item.available, "snapshot.capacity.available")
  const capacityReached = requiredBoolean(item.capacityReached, "snapshot.capacity.capacityReached")
  const readyLaneIDs = stringArray(item.readyLaneIDs, "snapshot.capacity.readyLaneIDs")
  if (activeCount !== activeLaneIDs.length) fail("snapshot.capacity activeCount does not match activeLaneIDs")
  if (maxConcurrentLanes === 0 && (available !== null || capacityReached)) {
    fail("snapshot.capacity unlimited mode is inconsistent")
  }
  if (maxConcurrentLanes > 0 && available !== Math.max(0, maxConcurrentLanes - activeCount)) {
    fail("snapshot.capacity available does not match max and active count")
  }
  if (capacityReached !== (maxConcurrentLanes > 0 && activeCount >= maxConcurrentLanes)) {
    fail("snapshot.capacity capacityReached is inconsistent")
  }
  return { maxConcurrentLanes, activeLaneIDs, activeCount, available, capacityReached, readyLaneIDs }
}

function parseLane(value: unknown, label: string): MotryxLaneProjection {
  const item = requiredRecord(value, label)
  return compact({
    id: requiredString(item.id, `${label}.id`),
    name: requiredString(item.name, `${label}.name`),
    status: requiredString(item.status, `${label}.status`),
    updatedAt: timestamp(item.updatedAt, `${label}.updatedAt`),
    lastCheckResult: optionalString(item.lastCheckResult, `${label}.lastCheckResult`),
    pendingCheckSummary: optionalString(item.pendingCheckSummary, `${label}.pendingCheckSummary`),
    reopenCount: nonNegativeInteger(item.reopenCount, `${label}.reopenCount`),
    repairCycle: nonNegativeInteger(item.repairCycle, `${label}.repairCycle`),
    dependsOnLaneIDs: stringArray(item.dependsOnLaneIDs, `${label}.dependsOnLaneIDs`),
    coordinatorSlotID: optionalString(item.coordinatorSlotID, `${label}.coordinatorSlotID`),
    checkerSlotID: optionalString(item.checkerSlotID, `${label}.checkerSlotID`),
    coordinatorRuntimeReadiness: requiredString(
      item.coordinatorRuntimeReadiness,
      `${label}.coordinatorRuntimeReadiness`,
    ),
    checkerRuntimeReadiness: requiredString(item.checkerRuntimeReadiness, `${label}.checkerRuntimeReadiness`),
    coordinatorRuntime: parseRuntimeTarget(item.coordinatorRuntime, `${label}.coordinatorRuntime`),
    checkerRuntime: parseRuntimeTarget(item.checkerRuntime, `${label}.checkerRuntime`),
    schedulingPhase: optionalEnum(
      item.schedulingPhase,
      new Set(["READY", "PREPARING"] as const),
      `${label}.schedulingPhase`,
    ),
    runPhase: parseRunPhase(item.runPhase, `${label}.runPhase`),
    requestMessageID: optionalString(item.requestMessageID, `${label}.requestMessageID`),
    requestDeadlineAt: optionalFiniteNumber(item.requestDeadlineAt, `${label}.requestDeadlineAt`),
    failure: item.failure === undefined ? undefined : parseLaneFailure(item.failure, `${label}.failure`),
  })
}

function parseLaneFailure(value: unknown, label: string): MotryxLaneFailureProjection {
  const item = requiredRecord(value, label)
  if (item.role !== "coordinator" && item.role !== "checker") fail(`${label}.role is invalid`)
  if (item.presentationState !== "VISIBLE" && item.presentationState !== "DISMISSED") {
    fail(`${label}.presentationState is invalid`)
  }
  return {
    incidentID: requiredString(item.incidentID, `${label}.incidentID`),
    role: item.role,
    kind: requiredString(item.kind, `${label}.kind`),
    safeSummary: requiredString(item.safeSummary, `${label}.safeSummary`),
    openedAt: finiteNumber(item.openedAt, `${label}.openedAt`),
    presentationState: item.presentationState,
  }
}

function parseRuntimeIncident(value: unknown, label: string): MotryxRuntimeIncidentProjection {
  const item = requiredRecord(value, label)
  if (item.scopeKind !== "LANE" && item.scopeKind !== "SESSION") fail(`${label}.scopeKind is invalid`)
  if (item.status !== "OPEN" && item.status !== "RESOLVED") fail(`${label}.status is invalid`)
  if (item.presentationState !== "VISIBLE" && item.presentationState !== "DISMISSED") {
    fail(`${label}.presentationState is invalid`)
  }
  return compact({
    incidentID: requiredString(item.incidentID, `${label}.incidentID`),
    scopeKind: item.scopeKind,
    laneID: optionalString(item.laneID, `${label}.laneID`),
    role: requiredString(item.role, `${label}.role`),
    failedPhase: requiredString(item.failedPhase, `${label}.failedPhase`),
    failureKind: requiredString(item.failureKind, `${label}.failureKind`),
    status: item.status,
    presentationState: item.presentationState,
    safeSummary: requiredString(item.safeSummary, `${label}.safeSummary`),
    instanceID: optionalString(item.instanceID, `${label}.instanceID`),
    sessionID: optionalString(item.sessionID, `${label}.sessionID`),
    turnID: optionalString(item.turnID, `${label}.turnID`),
    providerID: optionalString(item.providerID, `${label}.providerID`),
    modelID: optionalString(item.modelID, `${label}.modelID`),
    httpStatus: optionalFiniteNumber(item.httpStatus, `${label}.httpStatus`),
    transportKind: optionalString(item.transportKind, `${label}.transportKind`),
    transportCode: optionalString(item.transportCode, `${label}.transportCode`),
    retryable: optionalBoolean(item.retryable, `${label}.retryable`),
    retryExhausted: optionalBoolean(item.retryExhausted, `${label}.retryExhausted`),
    attemptCount: optionalFiniteNumber(item.attemptCount, `${label}.attemptCount`),
    runID: optionalString(item.runID, `${label}.runID`),
    attemptID: optionalString(item.attemptID, `${label}.attemptID`),
    proofRef: optionalString(item.proofRef, `${label}.proofRef`),
    occurrenceCount: positiveInteger(item.occurrenceCount, `${label}.occurrenceCount`),
    openedAt: finiteNumber(item.openedAt, `${label}.openedAt`),
    lastSeenAt: finiteNumber(item.lastSeenAt, `${label}.lastSeenAt`),
    resolvedAt: optionalFiniteNumber(item.resolvedAt, `${label}.resolvedAt`),
  }) as MotryxRuntimeIncidentProjection
}

function parseAttention(value: unknown): MotryxControlSnapshot["attention"] {
  const item = requiredRecord(value, "snapshot.attention")
  return {
    visibleOpenIncidentCount: nonNegativeInteger(
      item.visibleOpenIncidentCount,
      "snapshot.attention.visibleOpenIncidentCount",
    ),
    failedLaneCount: nonNegativeInteger(item.failedLaneCount, "snapshot.attention.failedLaneCount"),
    activeAttentionCount: nonNegativeInteger(item.activeAttentionCount, "snapshot.attention.activeAttentionCount"),
    userActionRequiredCount: nonNegativeInteger(
      item.userActionRequiredCount,
      "snapshot.attention.userActionRequiredCount",
    ),
    retryingCount: nonNegativeInteger(item.retryingCount, "snapshot.attention.retryingCount"),
  }
}

const ATTENTION_KINDS = new Set<MotryxAttentionKind>([
  "PROVIDER_RETRY",
  "RUN_RETRY_SCHEDULED",
  "RUN_RETRY_RUNNING",
  "PROTOCOL_CORRECTION",
  "DELIVERY_RETRY",
  "OUTCOME_UNKNOWN",
  "WAITING_ATTENTION",
  "WAITING_RUNTIME_REPAIR",
  "WAITING_RECONCILIATION",
  "USER_PAUSED",
  "RUNTIME_RESTART",
  "FINAL_FAILURE",
])

function parseAttentionItem(value: unknown, label: string): MotryxAttentionItemProjection {
  const item = requiredRecord(value, label)
  const kind = exactEnum(item.kind, ATTENTION_KINDS, `${label}.kind`)
  const severity = exactEnum(item.severity, new Set(["INFO", "WARNING", "ERROR"] as const), `${label}.severity`)
  const scopeKind = exactEnum(item.scopeKind, new Set(["LANE", "SESSION"] as const), `${label}.scopeKind`)
  const presentationState = exactEnum(
    item.presentationState,
    new Set(["VISIBLE", "DISMISSED"] as const),
    `${label}.presentationState`,
  )
  const retryLayer = item.retryLayer === undefined
    ? undefined
    : exactEnum(item.retryLayer, new Set(["PROVIDER", "DELIVERY", "RUN", "PROTOCOL"] as const), `${label}.retryLayer`)
  return compact({
    attentionID: requiredString(item.attentionID, `${label}.attentionID`),
    kind,
    severity,
    scopeKind,
    role: requiredString(item.role, `${label}.role`),
    laneID: optionalString(item.laneID, `${label}.laneID`),
    runID: optionalString(item.runID, `${label}.runID`),
    attemptID: optionalString(item.attemptID, `${label}.attemptID`),
    incidentID: optionalString(item.incidentID, `${label}.incidentID`),
    summary: requiredString(item.summary, `${label}.summary`),
    reasonCode: optionalString(item.reasonCode, `${label}.reasonCode`),
    nextAction: optionalString(item.nextAction, `${label}.nextAction`),
    dismissible: requiredBoolean(item.dismissible, `${label}.dismissible`),
    presentationState,
    createdAt: finiteNumber(item.createdAt, `${label}.createdAt`),
    actionRequired: requiredBoolean(item.actionRequired, `${label}.actionRequired`),
    retryLayer,
    retryAttempt: optionalNonNegativeInteger(item.retryAttempt, `${label}.retryAttempt`),
    retryLimit: optionalNonNegativeInteger(item.retryLimit, `${label}.retryLimit`),
    retryNotBefore: optionalFiniteNumber(item.retryNotBefore, `${label}.retryNotBefore`),
    failureKind: optionalString(item.failureKind, `${label}.failureKind`),
    httpStatus: optionalFiniteNumber(item.httpStatus, `${label}.httpStatus`),
    transportKind: optionalString(item.transportKind, `${label}.transportKind`),
    transportCode: optionalString(item.transportCode, `${label}.transportCode`),
    providerID: optionalString(item.providerID, `${label}.providerID`),
    modelID: optionalString(item.modelID, `${label}.modelID`),
  }) as MotryxAttentionItemProjection
}

function parseRuntimeTarget(value: unknown, label: string): MotryxRuntimeTargetProjection | undefined {
  if (value === undefined) return
  const item = requiredRecord(value, label)
  return {
    slotID: requiredString(item.slotID, `${label}.slotID`),
    instanceID: requiredString(item.instanceID, `${label}.instanceID`),
    sessionID: requiredString(item.sessionID, `${label}.sessionID`),
  }
}

function parseAgent(value: unknown, label: string): MotryxAgentProjection {
  const item = requiredRecord(value, label)
  return compact({
    instanceID: requiredString(item.instanceID, `${label}.instanceID`),
    role: requiredString(item.role, `${label}.role`),
    sessionID: requiredString(item.sessionID, `${label}.sessionID`, true),
    orchestratorSessionID: optionalString(item.orchestratorSessionID, `${label}.orchestratorSessionID`),
    status: requiredString(item.status, `${label}.status`),
    laneIDs: stringArray(item.laneIDs, `${label}.laneIDs`),
  })
}

function parseArtifact(value: unknown, label: string): MotryxArtifactProjection {
  const item = requiredRecord(value, label)
  return compact({
    id: requiredString(item.id, `${label}.id`),
    workflowID: requiredString(item.workflowID, `${label}.workflowID`),
    producedByLaneID: requiredString(item.producedByLaneID, `${label}.producedByLaneID`),
    kind: requiredString(item.kind, `${label}.kind`),
    title: requiredString(item.title, `${label}.title`),
    path: requiredString(item.path, `${label}.path`, true),
    locatorRef: requiredString(item.locatorRef, `${label}.locatorRef`),
    version: positiveInteger(item.version, `${label}.version`),
    status: requiredString(item.status, `${label}.status`),
    snapshotError: optionalString(item.snapshotError, `${label}.snapshotError`),
    detail: requiredString(item.detail, `${label}.detail`, true),
    mtime: finiteNumber(item.mtime, `${label}.mtime`),
  })
}

function parseFunctionSlot(value: unknown, label: string): MotryxFunctionSlotProjection {
  const item = requiredRecord(value, label)
  return compact({
    slotID: requiredString(item.slotID, `${label}.slotID`),
    slotKey: requiredString(item.slotKey, `${label}.slotKey`),
    role: requiredString(item.role, `${label}.role`),
    runtimeReadiness: requiredString(item.runtimeReadiness, `${label}.runtimeReadiness`),
  })
}

function parseRun(value: unknown, label: string): MotryxRunProjection {
  const item = requiredRecord(value, label)
  return compact({
    runID: requiredString(item.runID, `${label}.runID`),
    workflowID: optionalString(item.workflowID, `${label}.workflowID`),
    scopeKind: exactEnum(item.scopeKind, new Set(["LANE_PRIMARY", "SLOT_INPUT", "SESSION_INPUT"] as const), `${label}.scopeKind`),
    runKind: exactEnum(item.runKind, new Set([
      "COORDINATOR", "CHECKER", "LANE_DECISION", "ORCHESTRATOR_TURN", "ANALYST_ADVISORY", "A2A_RESPONDER",
      "NOTIFICATION",
    ] as const), `${label}.runKind`),
    status: exactEnum(item.status, new Set(["OPEN", "WAITING", "SUCCEEDED", "FAILED", "CANCELED"] as const), `${label}.status`),
    laneID: optionalString(item.laneID, `${label}.laneID`),
    relatedLaneID: optionalString(item.relatedLaneID, `${label}.relatedLaneID`),
    logicalOwnerKind: exactEnum(
      item.logicalOwnerKind,
      new Set(["FUNCTION_SLOT", "CONTROL_ROLE"] as const),
      `${label}.logicalOwnerKind`,
    ),
    logicalOwnerID: requiredString(item.logicalOwnerID, `${label}.logicalOwnerID`),
    waitingKind: optionalEnum(item.waitingKind, new Set([
      "a2a_request", "attention", "runtime_repair", "reconciliation", "user_paused", "runtime_restart",
    ] as const), `${label}.waitingKind`),
    waitingRef: optionalString(item.waitingRef, `${label}.waitingRef`),
    sourceKind: requiredString(item.sourceKind, `${label}.sourceKind`),
    sourceID: requiredString(item.sourceID, `${label}.sourceID`),
    revision: nonNegativeInteger(item.revision, `${label}.revision`),
    errorRetryCount: nonNegativeInteger(item.errorRetryCount, `${label}.errorRetryCount`),
    maxErrorRetries: nonNegativeInteger(item.maxErrorRetries, `${label}.maxErrorRetries`),
    protocolCorrectionCount: nonNegativeInteger(
      item.protocolCorrectionCount,
      `${label}.protocolCorrectionCount`,
    ),
    maxProtocolCorrections: nonNegativeInteger(item.maxProtocolCorrections, `${label}.maxProtocolCorrections`),
    retryNotBefore: optionalFiniteNumber(item.retryNotBefore, `${label}.retryNotBefore`),
    retryDisposition: optionalEnum(
      item.retryDisposition,
      new Set(["ALLOWED_AFTER_REPAIR", "RECONCILIATION_REQUIRED", "FORBIDDEN"] as const),
      `${label}.retryDisposition`,
    ),
    resultRef: optionalString(item.resultRef, `${label}.resultRef`),
    failureRef: optionalString(item.failureRef, `${label}.failureRef`),
    createdAt: finiteNumber(item.createdAt, `${label}.createdAt`),
    terminalAt: optionalFiniteNumber(item.terminalAt, `${label}.terminalAt`),
    currentAttemptID: optionalString(item.currentAttemptID, `${label}.currentAttemptID`),
  })
}

function parseAttempt(value: unknown, label: string): MotryxAttemptProjection {
  const item = requiredRecord(value, label)
  return compact({
    attemptID: requiredString(item.attemptID, `${label}.attemptID`),
    runID: requiredString(item.runID, `${label}.runID`),
    attemptNo: positiveInteger(item.attemptNo, `${label}.attemptNo`),
    reason: exactEnum(
      item.reason,
      new Set(["INITIAL", "ERROR_RETRY", "PROTOCOL_CORRECTION", "WAIT_RESUME"] as const),
      `${label}.reason`,
    ),
    instanceID: requiredString(item.instanceID, `${label}.instanceID`),
    sessionID: requiredString(item.sessionID, `${label}.sessionID`),
    stableInputID: requiredString(item.stableInputID, `${label}.stableInputID`),
    state: exactEnum(
      item.state,
      new Set(["PENDING", "RUNNING", "OUTCOME_UNKNOWN", "TERMINAL"] as const),
      `${label}.state`,
    ),
    submitCount: nonNegativeInteger(item.submitCount, `${label}.submitCount`),
    createdAt: finiteNumber(item.createdAt, `${label}.createdAt`),
    dispatchNotBefore: optionalFiniteNumber(item.dispatchNotBefore, `${label}.dispatchNotBefore`),
    lastSubmitError: optionalString(item.lastSubmitError, `${label}.lastSubmitError`),
    turnID: optionalString(item.turnID, `${label}.turnID`),
    startedAt: optionalFiniteNumber(item.startedAt, `${label}.startedAt`),
    terminalKind: optionalEnum(item.terminalKind, new Set([
      "NOT_STARTED", "COMPLETED", "FAILED", "INTERRUPTED", "PROCESS_LOST", "CANCELED_BEFORE_START",
    ] as const), `${label}.terminalKind`),
    terminalProofRef: optionalString(item.terminalProofRef, `${label}.terminalProofRef`),
    terminalAt: optionalFiniteNumber(item.terminalAt, `${label}.terminalAt`),
    inputVisibility: optionalEnum(item.inputVisibility, new Set([
      "NOT_ADMITTED", "ADMITTED_UNPROMOTED", "PROMOTED_TRANSCRIPT_VISIBLE",
    ] as const), `${label}.inputVisibility`),
    failureKind: optionalString(item.failureKind, `${label}.failureKind`),
    failureSafeSummary: optionalString(item.failureSafeSummary, `${label}.failureSafeSummary`),
    providerID: optionalString(item.providerID, `${label}.providerID`),
    modelID: optionalString(item.modelID, `${label}.modelID`),
    httpStatus: optionalFiniteNumber(item.httpStatus, `${label}.httpStatus`),
    transportKind: optionalString(item.transportKind, `${label}.transportKind`),
    transportCode: optionalString(item.transportCode, `${label}.transportCode`),
    hostRetryable: optionalBoolean(item.hostRetryable, `${label}.hostRetryable`),
    hostRetryExhausted: optionalBoolean(item.hostRetryExhausted, `${label}.hostRetryExhausted`),
    hostAttemptCount: optionalNonNegativeInteger(item.hostAttemptCount, `${label}.hostAttemptCount`),
    cancelOrigin: optionalEnum(
      item.cancelOrigin,
      new Set(["USER", "FRAMEWORK", "SHUTDOWN", "STALE", "BUSINESS"] as const),
      `${label}.cancelOrigin`,
    ),
    cancelReason: optionalString(item.cancelReason, `${label}.cancelReason`),
    cancelRequestedAt: optionalFiniteNumber(item.cancelRequestedAt, `${label}.cancelRequestedAt`),
  })
}

function parseRunPhase(value: unknown, label: string): MotryxLaneProjection["runPhase"] {
  if (value === undefined) return
  if (value !== "EXECUTING" && value !== "WAITING_RESPONSE" && value !== "RESUME_QUEUED") {
    fail(`${label} is invalid`)
  }
  return value
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function requiredArray<T>(value: unknown, label: string, parse: (value: unknown, label: string) => T): T[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value.map((item, index) => parse(item, `${label}[${index}]`))
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value))
    fail(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`)
  return value as string
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return
  return requiredString(value, label, true)
}

function exactString(value: unknown, expected: string, label: string) {
  const actual = requiredString(value, label)
  if (actual !== expected) fail(`${label} does not match the requested identity`)
  return actual
}

function exactProject(value: unknown, expected: string, label: string) {
  const actual = path.resolve(requiredString(value, label))
  if (actual !== path.resolve(expected)) fail(`${label} does not match the requested project`)
  return actual
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a finite number`)
  return value as number
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return
  return finiteNumber(value, label)
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return
  if (typeof value !== "boolean") fail(`${label} must be a boolean`)
  return value
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`)
  return value as number
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return
  return nonNegativeInteger(value, label)
}

function exactEnum<const T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) fail(`${label} is invalid`)
  return value as T
}

function optionalEnum<const T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T | undefined {
  if (value === undefined) return
  return exactEnum(value, allowed, label)
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result < 1) fail(`${label} must be positive`)
  return result
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${label} must be a string array`)
  return value as string[]
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (!Number.isFinite(Date.parse(result))) fail(`${label} must be a valid timestamp`)
  return result
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function fail(message: string): never {
  throw new MotryxControlSchemaError(message)
}
