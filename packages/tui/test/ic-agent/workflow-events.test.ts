import { expect, test } from "bun:test"
import { subscribeToWorkflowEvents, workflowEventsTokenFromEnv, workflowEventsURL, workflowEventsURLFromEnv } from "../../src/ic-agent/workflow-events"

test("derives Motryx workflow events URL from explicit events or API endpoints", () => {
  expect(workflowEventsURL({
    eventsURL: "http://127.0.0.1:8765/ic/events",
  })).toBe("http://127.0.0.1:8765/ic/events")
  expect(workflowEventsURL({
    apiURL: "http://127.0.0.1:8765",
  })).toBe("http://127.0.0.1:8765/ic/events")
  expect(workflowEventsURL({
    apiURL: "http://127.0.0.1:8765/ic/workflow",
  })).toBe("http://127.0.0.1:8765/ic/events")
  expect(workflowEventsURL({
    apiURL: "http://127.0.0.1:8765/ic/workflows/current",
  })).toBe("http://127.0.0.1:8765/ic/events")
})

test("derives Motryx workflow events URL from environment", () => {
  expect(workflowEventsURLFromEnv({
    MOTRYX_WORKFLOW_API_URL: "http://127.0.0.1:9000/ic/workflow",
  })).toBe("http://127.0.0.1:9000/ic/events")
  expect(workflowEventsURLFromEnv({
    MOTRYX_WORKFLOW_EVENTS_URL: "http://127.0.0.1:9001/ic/events",
    MOTRYX_WORKFLOW_API_URL: "http://127.0.0.1:9000/ic/workflow",
  })).toBe("http://127.0.0.1:9001/ic/events")
})

test("derives Motryx workflow events token from environment", () => {
  expect(workflowEventsTokenFromEnv({
    MOTRYX_WORKFLOW_API_TOKEN: "api-token",
  })).toBe("api-token")
  expect(workflowEventsTokenFromEnv({
    MOTRYX_WORKFLOW_EVENTS_TOKEN: "events-token",
    MOTRYX_WORKFLOW_API_TOKEN: "api-token",
  })).toBe("events-token")
})

test("subscribes to Motryx workflow server-sent events", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer events-token")
      return new Response(
        [
          "event: snapshot",
          'data: {"workflow":{"id":"wf_events"}}',
          "",
          "event: heartbeat",
          'data: {"status":"ok"}',
          "",
        ].join("\n"),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
          },
        },
      )
    },
  })
  try {
    const seen: Array<{ event: string; dataText: string; data?: unknown }> = []
    let unsubscribe = () => {}
    await new Promise<void>((resolve, reject) => {
      unsubscribe = subscribeToWorkflowEvents({
        url: `http://127.0.0.1:${server.port}/ic/events`,
        token: "events-token",
        onEvent: (event) => {
          seen.push(event)
          if (seen.length === 2) {
            unsubscribe()
            resolve()
          }
        },
        onError: reject,
      })
    })

    expect(seen.map((event) => event.event)).toEqual(["snapshot", "heartbeat"])
    expect(seen[0]?.data).toEqual({
      workflow: {
        id: "wf_events",
      },
    })
  } finally {
    server.stop(true)
  }
})
