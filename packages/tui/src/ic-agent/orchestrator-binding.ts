import { SessionV2 } from "@opencode-ai/core/session"
import {
  currentMotryxBindingFromEnv as controlPlaneCurrentMotryxBindingFromEnv,
  ensureMotryxOrchestratorBinding as controlPlaneEnsureMotryxOrchestratorBinding,
  motryxBindingExists as controlPlaneMotryxBindingExists,
  readMotryxOrchestratorBinding as controlPlaneReadMotryxOrchestratorBinding,
  resolveMotryxRuntimePaths as controlPlaneResolveMotryxRuntimePaths,
} from "../../../../../scripts/motryx-control-plane.mjs"

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

export function createMotryxOrchestratorSessionID() {
  return SessionV2.ID.create()
}

export function resolveMotryxRuntimePaths(input: {
  projectDir: string
  env?: Record<string, string | undefined>
}): MotryxRuntimePaths {
  return controlPlaneResolveMotryxRuntimePaths(input)
}

export function ensureMotryxOrchestratorBinding(input: {
  projectDir: string
  sessionID: string
  env?: Record<string, string | undefined>
}): MotryxOrchestratorBinding {
  return controlPlaneEnsureMotryxOrchestratorBinding(input) as MotryxOrchestratorBinding
}

export function currentMotryxBindingFromEnv(env: Record<string, string | undefined> = process.env) {
  return controlPlaneCurrentMotryxBindingFromEnv(env)
}

export function readMotryxOrchestratorBinding(input: {
  projectDir: string
  sessionID: string
  env?: Record<string, string | undefined>
}): MotryxOrchestratorBinding | undefined {
  return controlPlaneReadMotryxOrchestratorBinding(input) as MotryxOrchestratorBinding | undefined
}

export function motryxBindingExists(input: {
  projectDir: string
  sessionID: string
  env?: Record<string, string | undefined>
}) {
  return controlPlaneMotryxBindingExists(input)
}
