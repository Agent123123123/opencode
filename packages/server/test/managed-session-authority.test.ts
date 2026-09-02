import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import type { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ManagedSessionAuthority as ProcessAuthority } from "@opencode-ai/core/session/authority"
import { ManagedSessionAuthority } from "../src/managed-session-authority"

const sessionID = SessionSchema.ID.make("ses_server_managed_authority")
const originalControllerToken = process.env.MOTRYX_CONTROLLER_TOKEN

const session = {
  get: () => Effect.succeed({ execution: { managed: true, gateOpen: true } }),
} as unknown as SessionV2.Interface

afterEach(() => {
  ProcessAuthority.revoke(sessionID)
  if (originalControllerToken === undefined) delete process.env.MOTRYX_CONTROLLER_TOKEN
  else process.env.MOTRYX_CONTROLLER_TOKEN = originalControllerToken
})

describe("managed session service write authority", () => {
  test("fails closed when the host has no controller token", async () => {
    delete process.env.MOTRYX_CONTROLLER_TOKEN
    const denied = await Effect.runPromiseExit(
      ManagedSessionAuthority.assertController().pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, {} as HttpServerRequest.HttpServerRequest),
      ),
    )
    expect(Exit.isFailure(denied)).toBe(true)
    if (Exit.isFailure(denied)) {
      expect(String(denied.cause)).toContain("Managed session controller is not configured")
    }
  })

  test("rejects a managed write in another host process even when the database identity is known", async () => {
    const denied = await Effect.runPromiseExit(ManagedSessionAuthority.assertWrite(session, sessionID))
    expect(Exit.isFailure(denied)).toBe(true)
    if (Exit.isFailure(denied)) {
      expect(String(denied.cause)).toContain("Managed session is not controlled by this host process")
    }

    ProcessAuthority.grant(sessionID)
    await expect(Effect.runPromise(ManagedSessionAuthority.assertWrite(session, sessionID))).resolves.toBeUndefined()
  })

  test("recognizes only the exact existing Motryx controller credential", async () => {
    process.env.MOTRYX_CONTROLLER_TOKEN = "exact-controller-token"
    const check = (token: string) =>
      Effect.runPromise(
        ManagedSessionAuthority.isController().pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, {
            headers: { [ManagedSessionAuthority.HEADER]: token },
          } as unknown as HttpServerRequest.HttpServerRequest),
        ),
      )

    await expect(check("exact-controller-token")).resolves.toBe(true)
    await expect(check("wrong-controller-token")).resolves.toBe(false)
  })
})
