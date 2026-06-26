export const MOTRYX_DEFAULT_AGENT = "orchestrator"

const HIDDEN_NATIVE_AGENTS = new Set(["build", "plan"])

type MotryxProductEnv = {
  OPENCODE_IC_AGENT_TUI?: string
  OPENCODE_IC_AGENT_THEME?: string
  OPENCODE_ROUTE?: string
}

export function isMotryxProductMode(env: MotryxProductEnv = process.env as MotryxProductEnv): boolean {
  if (env.OPENCODE_IC_AGENT_TUI === "1" || env.OPENCODE_IC_AGENT_TUI === "true") return true
  if (env.OPENCODE_IC_AGENT_THEME?.startsWith("motryx")) return true
  return env.OPENCODE_ROUTE?.includes('"ic-agent"') ?? false
}

export function isMotryxHiddenNativeAgent(name?: string): boolean {
  return !!name && HIDDEN_NATIVE_AGENTS.has(name)
}

export function motryxProductAgentName(name?: string): string {
  if (isMotryxHiddenNativeAgent(name)) return MOTRYX_DEFAULT_AGENT
  return name || MOTRYX_DEFAULT_AGENT
}

export function motryxProductAgentDisplayName(name?: string): string {
  return motryxProductAgentName(name)
}
