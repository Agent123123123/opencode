import { expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { motryxReadinessFromEnv } from "../../src/ic-agent/readiness"

test("reports Motryx channel readiness when the route is isolated", () => {
  const readiness = motryxReadinessFromEnv({
    OPENCODE_DB: "motryx.db",
    OPENCODE_CONFIG_DIR: "/work/project/.motryx/opencode",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MOTRYX_PROJECT_DIR: "/work/project",
    OPENAI_API_KEY: "set",
    MINIMAX_API_KEY: "set",
  })

  expect(readiness.readyForStart).toBe(true)
  expect(readiness.items).toContainEqual({
    id: "channel",
    tone: "ok",
    label: "Motryx channel",
    detail: "isolated config, project config disabled, motryx.db",
  })
  expect(readiness.items).toContainEqual({
    id: "native-db",
    tone: "ok",
    label: "Native DB",
    detail: "native OpenCode DB is not the Motryx channel",
  })
  expect(readiness.items.some((item) => item.id === "shared-db")).toBe(false)
})

test("warns when a shared OpenCode DB env leaks into Motryx", () => {
  const readiness = motryxReadinessFromEnv({
    OPENCODE_DB: "motryx.db",
    OPENCODE_CONFIG_DIR: "/work/project/.motryx/opencode",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MOTRYX_PROJECT_DIR: "/work/project",
    OPENCODE_DISABLE_CHANNEL_DB: "1",
    OPENAI_API_KEY: "set",
    MINIMAX_API_KEY: "set",
  })

  expect(readiness.readyForStart).toBe(false)
  expect(readiness.items).toContainEqual({
    id: "shared-db",
    tone: "warn",
    label: "OpenCode DB",
    detail: "shared DB env is set",
  })
})

test("warns when project OpenCode config is not disabled", () => {
  const readiness = motryxReadinessFromEnv({
    OPENCODE_DB: "motryx.db",
    OPENCODE_CONFIG_DIR: "/work/project/.motryx/opencode",
    MOTRYX_PROJECT_DIR: "/work/project",
    OPENAI_API_KEY: "set",
    MINIMAX_API_KEY: "set",
  })

  expect(readiness.readyForStart).toBe(false)
  expect(readiness.items).toContainEqual({
    id: "project-config",
    tone: "warn",
    label: "Project config",
    detail: "OPENCODE_DISABLE_PROJECT_CONFIG is not set",
  })
})

test("warns when OPENCODE_DB points at the native OpenCode database name", () => {
  const readiness = motryxReadinessFromEnv({
    OPENCODE_DB: "opencode.db",
    OPENCODE_CONFIG_DIR: "/work/project/.motryx/opencode",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MOTRYX_PROJECT_DIR: "/work/project",
    OPENAI_API_KEY: "set",
    MINIMAX_API_KEY: "set",
  })

  expect(readiness.readyForStart).toBe(false)
  expect(readiness.items).toContainEqual({
    id: "native-db",
    tone: "warn",
    label: "Native DB",
    detail: "OPENCODE_DB points at opencode.db",
  })
})

test("surfaces provider auth hints without blocking the empty session action", () => {
  const readiness = motryxReadinessFromEnv({
    OPENCODE_DB: "motryx.db",
    OPENCODE_CONFIG_DIR: "/work/project/.motryx/opencode",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MOTRYX_PROJECT_DIR: "/work/project",
  })

  expect(readiness.readyForStart).toBe(true)
  expect(readiness.items).toContainEqual({
    id: "openai-key",
    tone: "warn",
    label: "Orchestrator auth",
    detail: "OpenAI credential or OPENAI_API_KEY not found",
  })
  expect(readiness.items).toContainEqual({
    id: "secondary-key",
    tone: "info",
    label: "Worker auth",
    detail: "MiniMax/Anthropic credential may be needed later",
  })
})

test("uses user-level Motryx auth store credentials before warning about missing provider keys", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "motryx-readiness-"))
  try {
    const userDataRoot = path.join(root, ".local", "share", "motryx")
    const dataRoot = path.join(root, "project", ".motryx", "db")
    const authDir = userDataRoot
    mkdirSync(authDir, { recursive: true })
    writeFileSync(
      path.join(userDataRoot, "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600_000,
        },
        "minimax-cn-coding-plan": {
          type: "api",
          key: "minimax-token",
        },
      }),
    )

    const readiness = motryxReadinessFromEnv({
      OPENCODE_DB: "motryx.db",
      OPENCODE_CONFIG_DIR: path.join(root, ".motryx", "opencode"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      MOTRYX_PROJECT_DIR: root,
      HOME: root,
      MOTRYX_USER_DATA_HOME: userDataRoot,
      XDG_DATA_HOME: dataRoot,
    })

    expect(readiness.readyForStart).toBe(true)
    expect(readiness.items).toContainEqual({
      id: "openai-auth",
      tone: "ok",
      label: "Orchestrator auth",
      detail: "OpenAI credential found in Motryx auth store",
    })
    expect(readiness.items).toContainEqual({
      id: "secondary-auth",
      tone: "ok",
      label: "Worker auth",
      detail: "MiniMax credential found in Motryx auth store",
    })
    expect(readiness.items.some((item) => item.id === "openai-key")).toBe(false)
    expect(readiness.items.some((item) => item.id === "secondary-key")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("uses launcher-injected OpenCode auth content before filesystem auth", () => {
  const readiness = motryxReadinessFromEnv({
    OPENCODE_DB: "motryx.db",
    OPENCODE_CONFIG_DIR: "/work/project/.motryx/opencode",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    MOTRYX_PROJECT_DIR: "/work/project",
    OPENCODE_AUTH_CONTENT: JSON.stringify({
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      },
      "minimax-cn-coding-plan": {
        type: "api",
        key: "minimax-token",
      },
    }),
  })

  expect(readiness.readyForStart).toBe(true)
  expect(readiness.items).toContainEqual({
    id: "openai-auth",
    tone: "ok",
    label: "Orchestrator auth",
    detail: "OpenAI credential found in Motryx auth store",
  })
  expect(readiness.items).toContainEqual({
    id: "secondary-auth",
    tone: "ok",
    label: "Worker auth",
    detail: "MiniMax credential found in Motryx auth store",
  })
})
