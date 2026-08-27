export function visibleProviderLabel(model: string, provider: string) {
  const normalizedModel = model.trim().toLocaleLowerCase()
  const normalizedProvider = provider.trim().toLocaleLowerCase()
  if (!normalizedProvider || normalizedModel.includes(normalizedProvider)) return
  return provider
}
