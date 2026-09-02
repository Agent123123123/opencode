export * as ManagedSessionAuthority from "./managed-session-authority"

import { timingSafeEqual } from "node:crypto"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import type { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ManagedSessionAuthority as ProcessAuthority } from "@opencode-ai/core/session/authority"

export const HEADER = "x-motryx-controller-token"

function sameSecret(actual: string, expected: string) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const isController = Effect.fn("ManagedSessionAuthority.isController")(function* () {
  const expected = process.env.MOTRYX_CONTROLLER_TOKEN
  if (!expected) return false
  const request = yield* HttpServerRequest.HttpServerRequest
  return sameSecret(request.headers[HEADER] ?? "", expected)
})

export const assertController = Effect.fn("ManagedSessionAuthority.assertController")(function* () {
  const expected = process.env.MOTRYX_CONTROLLER_TOKEN
  if (!expected) {
    return yield* new UnauthorizedError({ message: "Managed session controller is not configured" })
  }
  if (yield* isController()) return
  return yield* new UnauthorizedError({ message: "Managed session controller authority is required" })
})

export const grant = Effect.fn("ManagedSessionAuthority.grant")(function* (sessionID: SessionSchema.ID) {
  yield* assertController()
  ProcessAuthority.grant(sessionID)
})

export const assertWrite = Effect.fn("ManagedSessionAuthority.assertWrite")(function* (
  session: SessionV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const info = yield* session.get(sessionID).pipe(
    Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
  )
  if (!info) return
  if (!info.execution.managed) return
  if (ProcessAuthority.has(sessionID)) return
  return yield* new UnauthorizedError({ message: "Managed session is not controlled by this host process" })
})

export const revoke = (sessionID: string) => {
  ProcessAuthority.revoke(SessionSchema.ID.make(sessionID))
}
