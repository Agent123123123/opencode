import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { MotryxControlConfig } from "../../src/feature-plugins/motryx/control"
import { createMotryxPromptAdmissionHandler } from "../../src/feature-plugins/motryx/prompt-admission-reconcile"

const config: MotryxControlConfig = {
  apiURL: "http://127.0.0.1:19000",
  token: "control-token",
  projectID: path.resolve("/tmp/motryx-prompt-admission-reconcile"),
  orchestratorSessionID: "ses_orchestrator",
}

const route = {
  sessionID: config.orchestratorSessionID,
  serverGeneration: "server-generation",
  bindingGeneration: 7,
  ownerRunID: "run-owner",
}

function routable(overrides: Record<string, unknown> = {}) {
  const current = { ...route, ...overrides }
  return {
    schemaVersion: 6,
    projectID: config.projectID,
    status: "ROUTABLE",
    current,
    transition: null,
    sessions: [
      {
        sessionID: current.sessionID,
        title: "Current",
        lastRoutedAt: null,
        state: "CURRENT",
      },
    ],
  }
}

function unavailable() {
  return {
    schemaVersion: 6,
    projectID: config.projectID,
    status: "UNAVAILABLE",
    current: null,
    transition: null,
    sessions: [],
  }
}

function fetchSequence(states: unknown[]) {
  let index = 0
  return async () => Response.json(states[Math.min(index++, states.length - 1)])
}

describe("Motryx prompt admission reconciliation", () => {
  test("retries a transport failure only after the exact route becomes ROUTABLE", async () => {
    let attempts = 0
    let waiting = 0
    let reconciled = 0
    const handler = createMotryxPromptAdmissionHandler(config, {
      fetcher: fetchSequence([routable(), unavailable(), routable()]),
      sleep: async () => {},
      onWaiting: () => waiting++,
      onReconciled: () => reconciled++,
    })

    await handler({ sessionID: config.orchestratorSessionID, inputID: "msg_retry" }, async () => {
      attempts++
      if (attempts === 1) throw new TypeError("fetch failed")
    })

    expect(attempts).toBe(2)
    expect(waiting).toBe(1)
    expect(reconciled).toBe(1)
  })

  test("recognizes Bun connection errors as transport failures", async () => {
    let attempts = 0
    const handler = createMotryxPromptAdmissionHandler(config, {
      fetcher: fetchSequence([routable(), routable()]),
      sleep: async () => {},
    })

    await handler({ sessionID: config.orchestratorSessionID, inputID: "msg_bun_transport" }, async () => {
      attempts++
      if (attempts === 1) {
        throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })
      }
    })
    expect(attempts).toBe(2)
  })

  test("does not retry HTTP or other semantic failures", async () => {
    let attempts = 0
    const failure = new Error("HTTP 500", { cause: { status: 500 } })
    const handler = createMotryxPromptAdmissionHandler(config, {
      fetcher: fetchSequence([routable()]),
      sleep: async () => {},
    })

    await expect(
      handler({ sessionID: config.orchestratorSessionID, inputID: "msg_semantic" }, async () => {
        attempts++
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(attempts).toBe(1)
  })

  test("fails closed instead of retrying across a route proof change", async () => {
    let attempts = 0
    const handler = createMotryxPromptAdmissionHandler(config, {
      fetcher: fetchSequence([routable(), routable({ serverGeneration: "replacement-generation" })]),
      sleep: async () => {},
    })

    await expect(
      handler({ sessionID: config.orchestratorSessionID, inputID: "msg_stale" }, async () => {
        attempts++
        throw new TypeError("connection reset")
      }),
    ).rejects.toThrow("route proof changed")
    expect(attempts).toBe(1)
  })

  test("fails closed when the prompt target is not the currently routed Orchestrator", async () => {
    let attempts = 0
    const handler = createMotryxPromptAdmissionHandler(config, {
      fetcher: fetchSequence([routable()]),
    })
    await expect(
      handler({ sessionID: "ses_worker", inputID: "msg_worker" }, async () => {
        attempts++
      }),
    ).rejects.toThrow("ROUTABLE for a different session")
    expect(attempts).toBe(0)
  })
})
