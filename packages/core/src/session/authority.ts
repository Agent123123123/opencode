export * as ManagedSessionAuthority from "./authority"

import { SessionSchema } from "./schema"
import type { SessionInput } from "./input"

const sessions = new Set<SessionSchema.ID>()
const inputs = new Map<string, {
  sessionID: SessionSchema.ID
  inputID: string
  claimID: string
  cell: SessionInput.ExecutionCellRef
  managedExecutionRef: SessionInput.ManagedExecutionRef
}>()

const inputKey = (sessionID: SessionSchema.ID, inputID: string) => `${sessionID}\0${inputID}`
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}
const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

export function grant(sessionID: SessionSchema.ID) {
  sessions.add(sessionID)
}

export function revoke(sessionID: SessionSchema.ID) {
  sessions.delete(sessionID)
  for (const [key, grant] of inputs) {
    if (grant.sessionID === sessionID) inputs.delete(key)
  }
}

export function has(sessionID: SessionSchema.ID) {
  return sessions.has(sessionID)
}

export function authorizeInput(input: {
  sessionID: SessionSchema.ID
  inputID: string
  claimID: string
  cell: SessionInput.ExecutionCellRef
  managedExecutionRef: SessionInput.ManagedExecutionRef
}): "authorized" | "conflict" | "session_unauthorized" {
  if (!sessions.has(input.sessionID)) return "session_unauthorized"
  if (input.managedExecutionRef.origin === "FRAMEWORK" && (
    input.managedExecutionRef.claimID !== input.claimID ||
    !same(input.managedExecutionRef.cell, input.cell)
  )) return "conflict"
  if (input.managedExecutionRef.origin === "DIRECT_USER" && (
    input.managedExecutionRef.claimID !== input.claimID ||
    !input.managedExecutionRef.owner || !input.managedExecutionRef.checkpoint ||
    !input.managedExecutionRef.cell || !same(input.managedExecutionRef.cell, input.cell)
  )) return "conflict"
  const key = inputKey(input.sessionID, input.inputID)
  const existing = inputs.get(key)
  if (existing) return same(existing, input) ? "authorized" : "conflict"
  inputs.set(key, { ...input })
  return "authorized"
}

export function revokeInput(input: {
  sessionID: SessionSchema.ID
  inputID: string
  claimID: string
  cell: SessionInput.ExecutionCellRef
}): "revoked" | "missing" | "conflict" {
  const key = inputKey(input.sessionID, input.inputID)
  const existing = inputs.get(key)
  if (!existing) return "missing"
  if (existing.claimID !== input.claimID || !same(existing.cell, input.cell)) return "conflict"
  inputs.delete(key)
  return "revoked"
}

export function allowsInput(input: {
  sessionID: SessionSchema.ID
  inputID: string
  managedExecutionRef?: SessionInput.ManagedExecutionRef
}) {
  if (!sessions.has(input.sessionID)) return false
  const grant = inputs.get(inputKey(input.sessionID, input.inputID))
  if (!grant || !input.managedExecutionRef) return false
  if (input.managedExecutionRef.origin === "DIRECT_USER") {
    return grant.managedExecutionRef.origin === "DIRECT_USER" &&
      grant.managedExecutionRef.productSessionID === input.managedExecutionRef.productSessionID
  }
  return same(grant.managedExecutionRef, input.managedExecutionRef)
}

export function executionRef(sessionID: SessionSchema.ID, inputID: string) {
  return inputs.get(inputKey(sessionID, inputID))?.managedExecutionRef
}
