import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { readMotryxOrchestratorBinding, resolveMotryxRuntimePaths } from "./orchestrator-binding"

export type MotryxProjectContext = {
  product: "Motryx"
  projectDir: string
  dataRoot: string
  channelDbPath: string
  motryxSessionDbPath: string
  currentOrchestratorSessionID?: string
  currentIcAgentDbPath?: string
  bindingStatus: "bound" | "explicit-ic-agent-db" | "missing-binding" | "alias-unresolved" | "none"
}

export function resolveMotryxProjectContext(input: {
  projectDir?: string
  selectedSessionID?: string
  env?: Record<string, string | undefined>
} = {}): MotryxProjectContext {
  const env = input.env ?? process.env
  const projectDir = resolve(input.projectDir || env.MOTRYX_PROJECT_DIR || process.cwd())
  const paths = resolveMotryxRuntimePaths({ projectDir, env })
  const selectedSessionID = input.selectedSessionID?.trim() || ""
  const envSessionID = (env.MOTRYX_ORCHESTRATOR_SESSION_ID || env.MOTRYX_RESUME_SESSION || "").trim()
  const currentOrchestratorSessionID = selectedSessionID || (envSessionID.startsWith("@") ? "" : envSessionID)
  const explicitIcAgentDbPath = env.MOTRYX_IC_AGENT_DB_PATH || env.IC_AGENT_DB_PATH || ""
  const motryxSessionDbPath = resolveMotryxSessionDbPath({ env, dataRoot: paths.dataRoot })

  if (explicitIcAgentDbPath) {
    return {
      product: "Motryx",
      projectDir: paths.projectDir,
      dataRoot: paths.dataRoot,
      channelDbPath: paths.channelDb,
      motryxSessionDbPath,
      currentOrchestratorSessionID: currentOrchestratorSessionID || undefined,
      currentIcAgentDbPath: resolve(explicitIcAgentDbPath),
      bindingStatus: "explicit-ic-agent-db",
    }
  }

  if (!currentOrchestratorSessionID) {
    return {
      product: "Motryx",
      projectDir: paths.projectDir,
      dataRoot: paths.dataRoot,
      channelDbPath: paths.channelDb,
      motryxSessionDbPath,
      bindingStatus: envSessionID.startsWith("@") ? "alias-unresolved" : "none",
    }
  }

  const binding = readMotryxOrchestratorBinding({
    projectDir: paths.projectDir,
    sessionID: currentOrchestratorSessionID,
    env,
  })

  return {
    product: "Motryx",
    projectDir: paths.projectDir,
    dataRoot: paths.dataRoot,
    channelDbPath: paths.channelDb,
    motryxSessionDbPath,
    currentOrchestratorSessionID,
    currentIcAgentDbPath: binding?.icAgentDbPath ? resolve(binding.icAgentDbPath) : undefined,
    bindingStatus: binding ? "bound" : "missing-binding",
  }
}

function resolveMotryxSessionDbPath(input: {
  env: Record<string, string | undefined>
  dataRoot: string
}) {
  const dbName = input.env.OPENCODE_DB || "motryx.db"
  if (isAbsolute(dbName)) return resolve(dbName)
  const dataHome = input.env.XDG_DATA_HOME || input.dataRoot
  const canonical = join(dataHome, "opencode", dbName)
  const legacy = join(dataHome, "opencode", "opencode-local.db")
  if (dbName === "motryx.db" && !existsSync(canonical) && existsSync(legacy)) return resolve(legacy)
  return resolve(canonical)
}
