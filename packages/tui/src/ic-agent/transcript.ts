const INTERNAL_LOG_PATTERNS = [
  /\bruntime_liveness\b/i,
  /\bwake_ack\b/i,
  /\bwake_id=/i,
  /\bsession_title=\[/i,
  /\bliveness recovery\b/i,
]

export function sanitizeMotryxTranscriptText(text: string) {
  const lines = text.trim().split(/\r?\n/)
  const visible = lines.filter((line) => !isInternalMotryxLogLine(line))
  return visible.join("\n").trim() || undefined
}

export function isInternalMotryxLogLine(line: string) {
  return INTERNAL_LOG_PATTERNS.some((pattern) => pattern.test(line))
}
