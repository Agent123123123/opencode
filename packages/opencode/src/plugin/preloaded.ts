import type { PluginModule } from "@opencode-ai/plugin"

type PreloadedPlugin = PluginModule & { id: string }

const modules = new Map<string, PreloadedPlugin>()

export function registerPreloadedPlugin(plugin: PreloadedPlugin) {
  if (modules.has(plugin.id)) throw new Error(`Preloaded plugin already registered: ${plugin.id}`)
  modules.set(plugin.id, plugin)
}

export function listPreloadedPlugins() {
  return [...modules.values()]
}
