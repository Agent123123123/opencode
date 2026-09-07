import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import type { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ManagedSessionAuthority as ProcessAuthority } from "@opencode-ai/core/session/authority"
import { SessionInput } from "@opencode-ai/core/session/input"
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
  test("authorizes only one exact Input, claim, cell, and immutable execution reference", () => {
    const inputID = "msg_exact_input_grant"
    const cell = {
      supervisorIncarnationID: "supervisor_exact",
      hostIncarnationID: "host_exact",
      sidecarIncarnationID: "sidecar_exact",
    }
    const managedExecutionRef = SessionInput.ManagedExecutionRef.make({
      schema: "motryx.managed_execution.v4",
      purpose: "orchestrator",
      origin: "FRAMEWORK",
      productSessionID: sessionID,
      owner: { kind: "CONTROL_ROLE", id: "owner_exact", generation: 2 },
      checkpoint: { kind: "CONTROL", id: "owner_exact" },
      cell,
      claimID: "claim_exact",
    })

    expect(ProcessAuthority.authorizeInput({
      sessionID,
      inputID,
      claimID: "claim_exact",
      cell,
      managedExecutionRef,
    })).toBe("session_unauthorized")
    ProcessAuthority.grant(sessionID)
    expect(ProcessAuthority.authorizeInput({
      sessionID,
      inputID,
      claimID: "claim_exact",
      cell,
      managedExecutionRef,
    })).toBe("authorized")
    expect(ProcessAuthority.allowsInput({ sessionID, inputID, managedExecutionRef })).toBe(true)
    expect(ProcessAuthority.authorizeInput({
      sessionID,
      inputID,
      claimID: "claim_conflict",
      cell,
      managedExecutionRef,
    })).toBe("conflict")
    expect(ProcessAuthority.revokeInput({
      sessionID,
      inputID,
      claimID: "claim_exact",
      cell,
    })).toBe("revoked")
    expect(ProcessAuthority.allowsInput({ sessionID, inputID, managedExecutionRef })).toBe(false)
  })

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
