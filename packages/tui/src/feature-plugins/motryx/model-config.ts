import { spawn } from "node:child_process"
import path from "node:path"

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

export function motryxModelSetArgv(command: MotryxModelSetCommand, tier: MotryxModelTier, model: string) {
  return [...command.argv, tier, model]
}

export async function setMotryxModelTier(
  command: MotryxModelSetCommand,
  tier: MotryxModelTier,
  model: string,
  options: {
    signal?: AbortSignal
    env?: Record<string, string | undefined>
  } = {},
) {
  if (options.signal?.aborted) throw new Error("Motryx model selection was cancelled")

  const argv = motryxModelSetArgv(command, tier, model)
  const childEnv = { ...(options.env ?? process.env) }
  delete childEnv.MOTRYX_CONTROL_API_TOKEN
  delete childEnv.MOTRYX_BINDING_TOKEN

  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: command.projectID,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const append = (chunk: Buffer | string) => {
      if (output.length >= 16_384) return
      output += String(chunk).slice(0, 16_384 - output.length)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)

    const abort = () => child.kill("SIGTERM")
    options.signal?.addEventListener("abort", abort, { once: true })
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      options.signal?.removeEventListener("abort", abort)
      if (code === 0) {
        resolve()
        return
      }
      const detail = output.trim()
      reject(
        new Error(
          detail ||
            `Motryx model configuration command failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`})`,
        ),
      )
    })
  })
}
