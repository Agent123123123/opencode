import path from "node:path"

export const MOTRYX_CONTROL_SCHEMA_VERSION = 2 as const

export type MotryxControlConfig = {
  apiURL: string
  token: string
  projectID: string
  orchestratorSessionID: string
}

export type MotryxFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

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
  readyAt?: number
  readyKind?: string
  dependsOnLaneIDs: string[]
  coordinatorSlotID?: string
  checkerSlotID?: string
  coordinatorRuntimeReadiness: string
  checkerRuntimeReadiness: string
  coordinatorRuntime?: MotryxRuntimeTargetProjection
  checkerRuntime?: MotryxRuntimeTargetProjection
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

export type MotryxInboxProjection = {
  inboxItemID: string
  targetKind: string
  targetID: string
  envelopeClass: string
  sourceType: string
  status: string
  laneID?: string
}

export type MotryxDeliveryFenceProjection = {
  fenceID: string
  instanceID: string
  inboxItemID: string
  state: string
  fenceGeneration: number
  expectedSessionID?: string
}

export type MotryxControlSnapshot = {
  schemaVersion: typeof MOTRYX_CONTROL_SCHEMA_VERSION
  projectID: string
  orchestratorSessionID: string
  projectionRevision: string
  route: MotryxRouteProof
  binding: MotryxBindingProof
  workflow?: MotryxWorkflowProjection
  lanes: MotryxLaneProjection[]
  agents: MotryxAgentProjection[]
  artifacts: MotryxArtifactProjection[]
  resourceBlocks: Record<string, unknown>[]
  functionSlots: MotryxFunctionSlotProjection[]
  inboxItems: MotryxInboxProjection[]
  deliveryFences: MotryxDeliveryFenceProjection[]
  diagnostics: Record<string, unknown>[]
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

export function motryxControlURL(config: MotryxControlConfig, endpoint: "workflow" | "events") {
  const url = new URL(endpoint === "workflow" ? "/ic/workflow" : "/ic/events", config.apiURL)
  url.searchParams.set("orchestrator_session_id", config.orchestratorSessionID)
  return url
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

export function parseMotryxControlSnapshot(value: unknown, expected: MotryxControlConfig): MotryxControlSnapshot {
  const root = requiredRecord(value, "snapshot")
  if (root.schemaVersion !== MOTRYX_CONTROL_SCHEMA_VERSION) fail("snapshot.schemaVersion must be 2")
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
    lanes: requiredArray(root.lanes, "snapshot.lanes", parseLane),
    agents: requiredArray(root.agents, "snapshot.agents", parseAgent),
    artifacts: requiredArray(root.artifacts, "snapshot.artifacts", parseArtifact),
    resourceBlocks: requiredArray(root.resourceBlocks, "snapshot.resourceBlocks", (item, label) =>
      requiredRecord(item, label),
    ),
    functionSlots: requiredArray(root.functionSlots, "snapshot.functionSlots", parseFunctionSlot),
    inboxItems: requiredArray(root.inboxItems, "snapshot.inboxItems", parseInboxItem),
    deliveryFences: requiredArray(root.deliveryFences, "snapshot.deliveryFences", parseDeliveryFence),
    diagnostics: requiredArray(root.diagnostics, "snapshot.diagnostics", (item, label) => requiredRecord(item, label)),
  }
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
    readyAt: optionalFiniteNumber(item.readyAt, `${label}.readyAt`),
    readyKind: optionalString(item.readyKind, `${label}.readyKind`),
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
  })
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

function parseInboxItem(value: unknown, label: string): MotryxInboxProjection {
  const item = requiredRecord(value, label)
  return compact({
    inboxItemID: requiredString(item.inboxItemID, `${label}.inboxItemID`),
    targetKind: requiredString(item.targetKind, `${label}.targetKind`),
    targetID: requiredString(item.targetID, `${label}.targetID`),
    envelopeClass: requiredString(item.envelopeClass, `${label}.envelopeClass`, true),
    sourceType: requiredString(item.sourceType, `${label}.sourceType`, true),
    status: requiredString(item.status, `${label}.status`),
    laneID: optionalString(item.laneID, `${label}.laneID`),
  })
}

function parseDeliveryFence(value: unknown, label: string): MotryxDeliveryFenceProjection {
  const item = requiredRecord(value, label)
  return compact({
    fenceID: requiredString(item.fenceID, `${label}.fenceID`),
    instanceID: requiredString(item.instanceID, `${label}.instanceID`),
    inboxItemID: requiredString(item.inboxItemID, `${label}.inboxItemID`),
    state: requiredString(item.state, `${label}.state`),
    fenceGeneration: nonNegativeInteger(item.fenceGeneration, `${label}.fenceGeneration`),
    expectedSessionID: optionalString(item.expectedSessionID, `${label}.expectedSessionID`),
  })
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`)
  return value as number
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
