import type { TuiPromptAdmission, TuiPromptAdmissionHandler } from "@opencode-ai/plugin/tui"

export function createPromptAdmissionInterceptors() {
  const handlers = new Map<symbol, TuiPromptAdmissionHandler>()

  return {
    register(handler: TuiPromptAdmissionHandler) {
      const key = Symbol()
      handlers.set(key, handler)
      return () => handlers.delete(key)
    },
    async admit(input: TuiPromptAdmission, admission: () => Promise<void>) {
      const chain = [...handlers.values()].reduceRight<() => Promise<void>>(
        (next, handler) => () => handler(input, next),
        admission,
      )
      await chain()
    },
    clear() {
      handlers.clear()
    },
  }
}

export type PromptAdmissionInterceptors = ReturnType<typeof createPromptAdmissionInterceptors>
