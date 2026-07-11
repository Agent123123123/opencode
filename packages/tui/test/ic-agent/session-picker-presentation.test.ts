import { expect, test } from "bun:test"
import { sessionDetails, sessionWorkflowLabel } from "../../src/ic-agent/session-picker-presentation"
import type { MotryxSessionHistoryItem } from "../../src/ic-agent/session-history"

test("prioritizes workflow goal and progress without exposing internal DB paths", () => {
  const session: MotryxSessionHistoryItem = {
    handle: "@1",
    id: "ses_internal",
    title: "verification",
    agent: "orchestrator",
    updated: 1,
    updatedText: "updated now",
    messageCount: 4,
    bindingStatus: "bound",
    icAgentDbPath: "/secret/internal/ic-agent.db",
    workflowSummary: {
      status: "ok",
      workflowID: "wf_1",
      workflowStatus: "active",
      goalPreview: "Close coverage",
      lanes: 8,
      active: 1,
      blocked: 1,
      checking: 1,
      pending: 1,
      done: 4,
      waived: 1,
    },
  }

  expect(sessionWorkflowLabel(session)).toBe("4/8 done · 1 active · 1 blocked · 1 pending")
  expect(sessionDetails(session)).toContain("Goal: Close coverage")
  expect(sessionDetails(session).join(" ")).not.toContain("/secret/internal")
})
