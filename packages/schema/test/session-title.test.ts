import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session-event"

const decode = Schema.decodeUnknownSync(Session.Title)

describe("Session title contract", () => {
  test("accepts a trimmed non-empty title of at most 100 characters", () => {
    expect(decode("Motryx Orchestrator")).toBe("Motryx Orchestrator")
    expect(decode("界".repeat(100))).toBe("界".repeat(100))
  })

  test("rejects blank, untrimmed, and overlong titles", () => {
    for (const title of ["", "   ", " leading", "trailing ", "界".repeat(101)]) {
      expect(() => decode(title)).toThrow()
    }
  })

  test("publishes title changes as a durable Session event", () => {
    expect(SessionEvent.TitleChanged.type).toBe("session.next.title.changed")
    expect(SessionEvent.DurableDefinitions).toContain(SessionEvent.TitleChanged)
  })

  test("round-trips the durable identity, timestamp, and Unicode title", () => {
    const event = Schema.decodeUnknownSync(SessionEvent.TitleChanged)({
      id: "evt_title_changed",
      type: "session.next.title.changed",
      durable: { aggregateID: "ses_title_roundtrip", seq: 3, version: 1 },
      data: {
        sessionID: "ses_title_roundtrip",
        timestamp: 42,
        title: "中文 Orchestrator",
      },
    })

    expect(Schema.encodeSync(SessionEvent.TitleChanged)(event)).toEqual({
      id: "evt_title_changed",
      type: "session.next.title.changed",
      durable: { aggregateID: "ses_title_roundtrip", seq: 3, version: 1 },
      data: {
        sessionID: "ses_title_roundtrip",
        timestamp: 42,
        title: "中文 Orchestrator",
      },
    })
  })
})
