import { describe, expect, test } from "bun:test"
import { ManagedSessionAuthority } from "@opencode-ai/core/session/authority"
import { SessionSchema } from "@opencode-ai/core/session/schema"

describe("managed session process authority", () => {
  test("grants and revokes only the exact session identity", () => {
    const granted = SessionSchema.ID.make("ses_managed_authority_granted")
    const other = SessionSchema.ID.make("ses_managed_authority_other")

    expect(ManagedSessionAuthority.has(granted)).toBe(false)
    expect(ManagedSessionAuthority.has(other)).toBe(false)
    ManagedSessionAuthority.grant(granted)
    expect(ManagedSessionAuthority.has(granted)).toBe(true)
    expect(ManagedSessionAuthority.has(other)).toBe(false)
    ManagedSessionAuthority.revoke(granted)
    expect(ManagedSessionAuthority.has(granted)).toBe(false)
  })
})
