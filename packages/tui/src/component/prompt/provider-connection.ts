export type ProviderConnectionRequirement = {
  providerID: string
  modelID: string
  variant: string
  message: string
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
    message: `Connect ${session.model.providerID} for model execution with ${session.model.id}#${variant}`,
  }
}
