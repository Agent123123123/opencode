type RecordValue = Record<string, unknown>

export type ProviderConnectionRequirement = {
  providerID: string
  modelID: string
  variant: string
  message: string
}

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null
}

export function providerConnectionRequirement(error: unknown): ProviderConnectionRequirement | undefined {
  const candidates = [error]
  for (let index = 0; index < candidates.length && index < 5; index++) {
    const candidate = candidates[index]
    if (!record(candidate)) continue
    if (
      candidate._tag === "ProviderConnectionRequiredError" &&
      typeof candidate.providerID === "string" &&
      typeof candidate.modelID === "string" &&
      typeof candidate.variant === "string" &&
      typeof candidate.message === "string"
    ) {
      return {
        providerID: candidate.providerID,
        modelID: candidate.modelID,
        variant: candidate.variant,
        message: candidate.message,
      }
    }
    for (const key of ["data", "error", "body", "cause"]) {
      if (record(candidate[key])) candidates.push(candidate[key])
    }
  }
}

export function managedSessionProviderRequirement(
  session:
    | {
        metadata?: Record<string, unknown>
        model?: { providerID: string; id: string; variant?: string }
      }
    | undefined,
  available: readonly { providerID: string; id: string }[],
): ProviderConnectionRequirement | undefined {
  if (session?.metadata?.executionManaged !== true || !session.model) return
  if (available.some((model) => model.providerID === session.model?.providerID && model.id === session.model.id)) return
  const variant = session.model.variant ?? "default"
  return {
    providerID: session.model.providerID,
    modelID: session.model.id,
    variant,
    message: `Connect ${session.model.providerID} to send prompts with ${session.model.id}#${variant}`,
  }
}
