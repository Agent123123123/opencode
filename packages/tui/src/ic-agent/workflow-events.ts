export type MotryxWorkflowEvent = {
  event: string
  dataText: string
  data?: unknown
}

export type MotryxWorkflowEventSubscription = {
  url: string
  onEvent: (event: MotryxWorkflowEvent) => void
  onError?: (error: unknown) => void
  fetcher?: typeof fetch
  token?: string
}

export function workflowEventsURLFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return workflowEventsURL({
    eventsURL: env.MOTRYX_WORKFLOW_EVENTS_URL,
    apiURL: env.MOTRYX_WORKFLOW_API_URL || env.MOTRYX_WORKFLOW_API,
  })
}

export function workflowEventsTokenFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return env.MOTRYX_WORKFLOW_EVENTS_TOKEN || env.MOTRYX_WORKFLOW_API_TOKEN || env.MOTRYX_WORKFLOW_SIDECAR_TOKEN || ""
}

export function workflowEventsURL(input: { eventsURL?: string; apiURL?: string }) {
  if (input.eventsURL?.trim()) return normalizeEventsURL(input.eventsURL)
  if (input.apiURL?.trim()) return eventsURLFromApiURL(input.apiURL)
  return ""
}

export function subscribeToWorkflowEvents(input: MotryxWorkflowEventSubscription) {
  const controller = new AbortController()
  let stopped = false
  void readWorkflowEvents({
    ...input,
    signal: controller.signal,
  }).catch((error) => {
    if (!stopped) input.onError?.(error)
  })
  return () => {
    stopped = true
    controller.abort()
  }
}

async function readWorkflowEvents(input: MotryxWorkflowEventSubscription & { signal: AbortSignal }) {
  const response = await (input.fetcher ?? fetch)(input.url, {
    signal: input.signal,
    headers: workflowEventHeaders(input.token),
  })
  if (!response.ok) {
    throw new Error(`Motryx workflow events returned ${response.status}`)
  }
  if (!response.body) {
    throw new Error("Motryx workflow events response has no body")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = consumeEventBlocks(buffer)
      buffer = parsed.rest
      parsed.events.forEach(input.onEvent)
    }
    buffer += decoder.decode()
    const parsed = consumeEventBlocks(`${buffer}\n\n`)
    parsed.events.forEach(input.onEvent)
  } finally {
    reader.releaseLock()
  }
}

function workflowEventHeaders(token: string | undefined): HeadersInit {
  return token?.trim()
    ? {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      }
    : {
        accept: "text/event-stream",
      }
}

function consumeEventBlocks(input: string) {
  const events: MotryxWorkflowEvent[] = []
  let rest = input
  while (true) {
    const separator = nextSeparator(rest)
    if (!separator) break
    const block = rest.slice(0, separator.index)
    rest = rest.slice(separator.index + separator.length)
    const event = parseEventBlock(block)
    if (event) events.push(event)
  }
  return { events, rest }
}

function parseEventBlock(block: string): MotryxWorkflowEvent | undefined {
  let event = "message"
  const dataLines: string[] = []
  block.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim() || "message"
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart())
  })
  if (dataLines.length === 0) return undefined
  const dataText = dataLines.join("\n")
  return {
    event,
    dataText,
    data: parseJson(dataText),
  }
}

function nextSeparator(input: string) {
  const lf = input.indexOf("\n\n")
  const crlf = input.indexOf("\r\n\r\n")
  if (lf === -1 && crlf === -1) return undefined
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1) return { index: lf, length: 2 }
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

function parseJson(input: string) {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

function normalizeEventsURL(raw: string) {
  const url = new URL(raw)
  const normalizedPath = url.pathname.replace(/\/+$/, "")
  if (normalizedPath.endsWith("/ic/events")) {
    url.pathname = normalizedPath
    return url.toString()
  }
  url.pathname = `${normalizedPath}/ic/events`.replace(/\/+/g, "/")
  return url.toString()
}

function eventsURLFromApiURL(raw: string) {
  const url = new URL(raw)
  const normalizedPath = url.pathname.replace(/\/+$/, "")
  if (normalizedPath.endsWith("/ic/events")) {
    url.pathname = normalizedPath
    return url.toString()
  }
  if (normalizedPath.endsWith("/ic/workflow")) {
    url.pathname = normalizedPath.slice(0, -"/workflow".length) + "/events"
    return url.toString()
  }
  if (normalizedPath.endsWith("/ic/workflows/current")) {
    url.pathname = normalizedPath.slice(0, -"/workflows/current".length) + "/events"
    return url.toString()
  }
  url.pathname = `${normalizedPath}/ic/events`.replace(/\/+/g, "/")
  return url.toString()
}
