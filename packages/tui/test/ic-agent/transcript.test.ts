import { expect, test } from "bun:test"
import { isInternalMotryxLogLine, sanitizeMotryxTranscriptText } from "../../src/ic-agent/transcript"

test("filters internal Motryx liveness lines from the product transcript", () => {
  const text = [
    "The coordinator is reviewing the scope.",
    "wake_ack [wake_id=abc123] id=runtime_liveness:lane_1 session_title=[coordinator] scope-discovery liveness recovery",
    "Next, the checker should inspect coverage.",
  ].join("\n")

  expect(sanitizeMotryxTranscriptText(text)).toBe([
    "The coordinator is reviewing the scope.",
    "Next, the checker should inspect coverage.",
  ].join("\n"))
})

test("hides a transcript part that only contains internal Motryx log lines", () => {
  expect(sanitizeMotryxTranscriptText("runtime_liveness wake_ack wake_id=abc")).toBeUndefined()
})

test("classifies Motryx runtime noise without hiding normal user-facing text", () => {
  expect(isInternalMotryxLogLine("wake_ack [wake_id=abc]")).toBe(true)
  expect(isInternalMotryxLogLine("The checker found one missing assertion.")).toBe(false)
})
