import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export type MotryxReadinessTone = "ok" | "warn" | "info"

export type MotryxReadinessItem = {
  id: string
  tone: MotryxReadinessTone
  label: string
  detail: string
}

export type MotryxReadiness = {
  readyForStart: boolean
  items: MotryxReadinessItem[]
}

export function motryxReadinessFromEnv(env: Record<string, string | undefined> = process.env): MotryxReadiness {
  const items: MotryxReadinessItem[] = []
  const dbName = env.OPENCODE_DB ?? ""
  const configDir = env.OPENCODE_CONFIG_DIR ?? ""
  const projectDir = env.MOTRYX_PROJECT_DIR ?? ""
  const auth = readMotryxAuth(env)
  const sharedDbEnv = env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  const projectConfigDisabled = env.OPENCODE_DISABLE_PROJECT_CONFIG === "1"
  const nativeDbUnused = dbName !== "opencode.db"
  const hasOpenAI = Boolean(env.OPENAI_API_KEY || auth.providers.has("openai"))
  const hasSecondary = Boolean(
    env.ANTHROPIC_API_KEY ||
      env.MINIMAX_API_KEY ||
      auth.providers.has("anthropic") ||
      auth.providers.has("minimax-cn-coding-plan"),
  )
  const channelLooksIsolated = dbName === "motryx.db" && configDir.includes(".motryx") && projectConfigDisabled

  if (channelLooksIsolated && projectDir) {
    items.push({
      id: "channel",
      tone: "ok",
      label: "Motryx channel",
      detail: "isolated config, project config disabled, motryx.db",
    })
  } else {
    items.push({
      id: "channel",
      tone: "warn",
      label: "Motryx channel",
      detail: "run motryx doctor before starting",
    })
  }

  if (!projectConfigDisabled) {
    items.push({
      id: "project-config",
      tone: "warn",
      label: "Project config",
      detail: "OPENCODE_DISABLE_PROJECT_CONFIG is not set",
    })
  }

  if (sharedDbEnv) {
    items.push({
      id: "shared-db",
      tone: "warn",
      label: "OpenCode DB",
      detail: "shared DB env is set",
    })
  }

  items.push({
    id: "native-db",
    tone: nativeDbUnused ? "ok" : "warn",
    label: "Native DB",
    detail: nativeDbUnused ? "native OpenCode DB is not the Motryx channel" : "OPENCODE_DB points at opencode.db",
  })

  if (hasOpenAI) {
    items.push({
      id: "openai-auth",
      tone: "ok",
      label: "Orchestrator auth",
      detail: auth.providers.has("openai") ? "OpenAI credential found in Motryx auth store" : "OPENAI_API_KEY set",
    })
  } else {
    items.push({
      id: "openai-key",
      tone: "warn",
      label: "Orchestrator auth",
      detail: "OpenAI credential or OPENAI_API_KEY not found",
    })
  }

  if (hasSecondary) {
    items.push({
      id: "secondary-auth",
      tone: "ok",
      label: "Worker auth",
      detail: auth.providers.has("minimax-cn-coding-plan")
        ? "MiniMax credential found in Motryx auth store"
        : "secondary model key set",
    })
  } else {
    items.push({
      id: "secondary-key",
      tone: "info",
      label: "Worker auth",
      detail: "MiniMax/Anthropic credential may be needed later",
    })
  }

  return {
    readyForStart: channelLooksIsolated && !sharedDbEnv && nativeDbUnused,
    items,
  }
}

function readMotryxAuth(env: Record<string, string | undefined>) {
  const providers = new Set<string>()
  if (env.OPENCODE_AUTH_CONTENT) {
    addAuthProviders(providers, env.OPENCODE_AUTH_CONTENT)
    return { authPath: "OPENCODE_AUTH_CONTENT", providers }
  }

  const authPath = motryxAuthPath(env)
  if (!authPath || !existsSync(authPath)) return { authPath, providers }
  addAuthProviders(providers, readFileSync(authPath, "utf8"))
  return { authPath, providers }
}

function addAuthProviders(providers: Set<string>, content: string) {
  try {
    const raw = JSON.parse(content)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return
    for (const [provider, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue
      const type = (value as { type?: unknown }).type
      if (type === "api" || type === "oauth" || type === "wellknown") providers.add(provider)
    }
  } catch {
    return
  }
}

function motryxAuthPath(env: Record<string, string | undefined>) {
  if (env.MOTRYX_AUTH_FILE) return env.MOTRYX_AUTH_FILE

  const userDataRoot = env.MOTRYX_USER_DATA_HOME || (env.HOME ? path.join(env.HOME, ".local", "share", "motryx") : "")
  if (userDataRoot) {
    const userAuth = path.join(userDataRoot, "auth.json")
    if (existsSync(userAuth)) return userAuth
  }

  const dataRoot = env.XDG_DATA_HOME || env.MOTRYX_DATA_ROOT
  if (!dataRoot) return userDataRoot ? path.join(userDataRoot, "auth.json") : ""
  return path.join(dataRoot, "opencode", "auth.json")
}
