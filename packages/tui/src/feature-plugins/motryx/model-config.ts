import { spawn } from "node:child_process"
import path from "node:path"
import type { MotryxSessionRoute } from "./control"

export const MOTRYX_MODEL_SET_COMMAND_ENV = "MOTRYX_MODEL_SET_COMMAND_JSON"

export type MotryxModelTier = "strong" | "weak"

export type MotryxModelSetCommand = {
  argv: string[]
  projectID: string
}

export type MotryxModelSetCommandResult = { ok: true; value: MotryxModelSetCommand } | { ok: false; error: string }

export function motryxModelSetCommandFromEnv(
  env: Record<string, string | undefined> = process.env,
): MotryxModelSetCommandResult {
  const raw = env[MOTRYX_MODEL_SET_COMMAND_ENV]?.trim()
  const project = env.MOTRYX_PROJECT_DIR?.trim()
  if (!raw) return { ok: false, error: `${MOTRYX_MODEL_SET_COMMAND_ENV} is missing` }
  if (!project) return { ok: false, error: "MOTRYX_PROJECT_DIR is missing" }

  let argv: unknown
  try {
    argv = JSON.parse(raw)
  } catch {
    return { ok: false, error: `${MOTRYX_MODEL_SET_COMMAND_ENV} must be a JSON argv array` }
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== "string" || !item)) {
    return { ok: false, error: `${MOTRYX_MODEL_SET_COMMAND_ENV} must be a non-empty JSON string argv array` }
  }
  if (!path.isAbsolute(argv[0])) {
    return { ok: false, error: `${MOTRYX_MODEL_SET_COMMAND_ENV} executable must be absolute` }
  }

  return {
    ok: true,
    value: {
      argv,
      projectID: path.resolve(project),
    },
  }
}

export function motryxModelSetArgv(command: MotryxModelSetCommand, tier: MotryxModelTier, model: string, expected: MotryxSessionRoute) {
  return [...command.argv, tier, model, "--json", "--expected-route", JSON.stringify({
    serverGeneration: expected.serverGeneration,
    currentSessionID: expected.sessionID,
    bindingGeneration: expected.bindingGeneration,
    ownerRunID: expected.ownerRunID,
  })]
}

export type MotryxModelApplication = {
  selection: { model: string; variant: string }
  status: "offline" | "accepted" | "partial" | "unconfirmed"
  accepted: { sessionID: string; role: string; applied: boolean }[]
  unconfirmed: { sessionID: string; role: string; message: string }[]
  message?: string
}

export function parseMotryxModelApplication(value: unknown, tier: MotryxModelTier): MotryxModelApplication {
  const root = record(value)
  if (root.status !== "ok" || root.tier !== tier) throw new Error("Invalid Motryx model setter response")
  const application = record(root.application)
  const policy = record(record(root.modelPolicy)[tier])
  const selection = application.status === "accepted" || application.status === "partial"
    ? record(application.selection) : policy
  if (typeof selection.model !== "string" || !selection.model.includes("/") ||
    typeof selection.variant !== "string" || !selection.variant.trim()) throw new Error("Invalid effective model selection")
  if (application.status !== "offline" && application.status !== "accepted" &&
    application.status !== "partial" && application.status !== "unconfirmed") throw new Error("Invalid model application status")
  if (application.status === "unconfirmed" && (typeof application.message !== "string" || !application.message)) {
    throw new Error("Missing model application failure")
  }
  const online = application.status === "accepted" || application.status === "partial"
  if (online && (application.schemaVersion !== 11 || application.tier !== tier ||
    !Array.isArray(application.accepted) || !Array.isArray(application.unconfirmed))) {
    throw new Error("Invalid online model application response")
  }
  const accepted = (online ? application.accepted as unknown[] : []).map((item) => {
    const entry = record(item)
    if (typeof entry.sessionID !== "string" || !entry.sessionID || typeof entry.role !== "string" || !entry.role ||
      typeof entry.applied !== "boolean") throw new Error("Invalid accepted model request")
    return { sessionID: entry.sessionID, role: entry.role, applied: entry.applied }
  })
  const unconfirmed = (online ? application.unconfirmed as unknown[] : []).map((item) => {
    const entry = record(item)
    if (typeof entry.sessionID !== "string" || !entry.sessionID || typeof entry.role !== "string" || !entry.role ||
      typeof entry.message !== "string" || !entry.message) throw new Error("Invalid unconfirmed model request")
    return { sessionID: entry.sessionID, role: entry.role, message: entry.message }
  })
  if (online && (application.status === "partial") !== (unconfirmed.length > 0)) throw new Error("Inconsistent model application status")
  return { status: application.status, selection: { model: selection.model, variant: selection.variant },
    accepted, unconfirmed, message: typeof application.message === "string" ? application.message : undefined }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model application response")
  return value as Record<string, unknown>
}

export async function setMotryxModelTier(
  command: MotryxModelSetCommand,
  tier: MotryxModelTier,
  model: string,
  options: {
    expected: MotryxSessionRoute
    signal?: AbortSignal
    env?: Record<string, string | undefined>
  },
) {
  if (options.signal?.aborted) throw new Error("Motryx model selection was cancelled")

  const argv = motryxModelSetArgv(command, tier, model, options.expected)
  const childEnv = { ...(options.env ?? process.env) }
  for (const key of ["MOTRYX_CONTROL_API_TOKEN", "MOTRYX_BINDING_TOKEN", "MOTRYX_CONTROLLER_TOKEN"]) {
    delete childEnv[key]
  }

  return new Promise<MotryxModelApplication>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: command.projectID,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += String(chunk).slice(0, Math.max(0, 262_144 - stdout.length)) })
    child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(0, Math.max(0, 16_384 - stderr.length)) })

    const abort = () => child.kill("SIGTERM")
    options.signal?.addEventListener("abort", abort, { once: true })
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort)
      if (options.signal?.aborted) {
        reject(new Error("Motryx model selection was cancelled"))
        return
      }
      try {
        const result = parseMotryxModelApplication(JSON.parse(stdout), tier)
        if (code !== (result.status === "partial" || result.status === "unconfirmed" ? 1 : 0)) {
          throw new Error("Model setter exit code disagrees with its response")
        }
        resolve(result)
      } catch (error) {
        reject(new Error(stderr.trim() || `Motryx model configuration command failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}): ${error instanceof Error ? error.message : String(error)}`))
      }
    })
  })
}
