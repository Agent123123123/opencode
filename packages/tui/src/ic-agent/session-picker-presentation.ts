import type { MotryxSessionHistoryItem } from "./session-history"

export function sessionWorkflowLabel(session: MotryxSessionHistoryItem) {
  const summary = session.workflowSummary
  if (!summary) return "workflow:unknown"
  if (summary.status === "missing-db") return "workflow:missing-db"
  if (summary.status === "unreadable") return "workflow:unreadable"
  if (summary.status === "empty") return "workflow:empty"
  const active = summary.active > 0 ? `${summary.active} active` : "idle"
  const blocked = summary.blocked > 0 ? ` · ${summary.blocked} blocked` : ""
  const pending = summary.pending > 0 ? ` · ${summary.pending} pending` : ""
  return `${summary.done}/${summary.lanes} done · ${active}${blocked}${pending}`
}

export function sessionDetails(session: MotryxSessionHistoryItem) {
  const details = [`${session.handle} · msg:${session.messageCount} · ${session.bindingStatus}${session.createdText ? ` · ${session.createdText}` : ""}`]
  if (session.workflowSummary?.goalPreview) details.push(`Goal: ${session.workflowSummary.goalPreview}`)
  if (session.requiredMigration) details.push(`Run motryx migrate · requires ${session.requiredMigration}`)
  if (session.workflowSummary?.workflowID) {
    details.push(`${session.workflowSummary.workflowStatus ?? "UNKNOWN"} · ${session.workflowSummary.workflowID}`)
  }
  return details
}
