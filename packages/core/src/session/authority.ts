export * as ManagedSessionAuthority from "./authority"

import { SessionSchema } from "./schema"

const sessions = new Set<SessionSchema.ID>()

export function grant(sessionID: SessionSchema.ID) {
  sessions.add(sessionID)
}

export function revoke(sessionID: SessionSchema.ID) {
  sessions.delete(sessionID)
}

export function has(sessionID: SessionSchema.ID) {
  return sessions.has(sessionID)
}
