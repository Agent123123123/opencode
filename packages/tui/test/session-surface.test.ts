import { describe, expect, test } from "bun:test"
import { sessionSurfaceCommandEnabled, sessionSurfaceSubagentFooterEnabled } from "../src/routes/session"

describe("SessionSurface interaction boundary", () => {
  test("keeps the standard interactive route behavior by default", () => {
    for (const command of ["session.share", "session.rename", "session.undo", "session.parent"]) {
      expect(sessionSurfaceCommandEnabled(undefined, command)).toBe(true)
      expect(sessionSurfaceCommandEnabled("interactive", command)).toBe(true)
    }
  })

  test("supports a narrow multi-agent policy that disables conversation history branching and rewrite", () => {
    for (const command of ["session.fork", "session.undo", "session.redo"]) {
      expect(sessionSurfaceCommandEnabled("interactive", command, "disabled")).toBe(false)
    }
    for (const command of ["session.timeline", "messages.copy", "session.export", "session.compact"]) {
      expect(sessionSurfaceCommandEnabled("interactive", command, "disabled")).toBe(true)
    }
  })

  test("blocks worker-session mutations while preserving inspection commands", () => {
    for (const command of [
      "session.share",
      "session.rename",
      "session.fork",
      "session.compact",
      "session.unshare",
      "session.undo",
      "session.redo",
      "session.background",
      "session.child.first",
      "session.parent",
      "session.child.next",
      "session.child.previous",
    ]) {
      expect(sessionSurfaceCommandEnabled("read-only", command)).toBe(false)
    }
    for (const command of ["session.timeline", "messages.copy", "session.copy", "session.export"]) {
      expect(sessionSurfaceCommandEnabled("read-only", command)).toBe(true)
    }
  })

  test("does not expose generic parent or sibling navigation in a read-only worker", () => {
    expect(sessionSurfaceSubagentFooterEnabled(undefined, "ses_parent")).toBe(true)
    expect(sessionSurfaceSubagentFooterEnabled("interactive", "ses_parent")).toBe(true)
    expect(sessionSurfaceSubagentFooterEnabled("read-only", "ses_parent")).toBe(false)
  })
})
