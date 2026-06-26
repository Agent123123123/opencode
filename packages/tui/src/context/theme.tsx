import { CliRenderEvents, SyntaxStyle, type TerminalColors } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  DEFAULT_THEMES,
  MOTRYX_DEFAULT_THEME,
  addTheme,
  allThemes,
  generateSubtleSyntax,
  generateSyntax,
  generateSystem,
  hasTheme,
  isTheme,
  motryxVisibleThemes,
  normalizeMotryxThemeName,
  resolveTheme,
  selectedForeground,
  setCustomThemes,
  setSystemTheme,
  subscribeThemes,
  terminalMode,
  tint,
  upsertTheme,
  type ThemeJson,
} from "../theme"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useTuiConfig } from "../config"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { readFile } from "node:fs/promises"
import path from "node:path"

export type ThemeSource = Readonly<{
  discover(): Promise<Record<string, unknown>>
  subscribeRefresh?(refresh: () => void): () => void
}>

const themeSource: ThemeSource = {
  async discover() {
    const directories = [Global.Path.config]
    for (let current = process.cwd(); ; current = path.dirname(current)) {
      directories.push(path.join(current, ".opencode"))
      if (path.dirname(current) === current) break
    }
    return discoverThemes(directories)
  },
  subscribeRefresh(refresh) {
    process.on("SIGUSR2", refresh)
    return () => process.off("SIGUSR2", refresh)
  },
}

export async function discoverThemes(directories: string[]) {
  const result: Record<string, unknown> = {}
  for (const directory of directories) {
    const files = await Glob.scan("themes/*.json", { cwd: directory, absolute: true, dot: true, symlink: true })
    for (const file of files) {
      result[path.basename(file, ".json")] = JSON.parse(await readFile(file, "utf8")) as unknown
    }
  }
  return result
}

export {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSubtleSyntax,
  generateSyntax,
  generateSystem,
  hasTheme,
  isTheme,
  resolveTheme,
  selectedForeground,
  terminalMode,
  tint,
  upsertTheme,
  type Theme,
  type ThemeJson,
  type SyntaxStyleOverrides,
} from "../theme"

const THEME_REFRESH_DELAYS = [250, 1000] as const

type State = {
  themes: Record<string, ThemeJson>
  mode: "dark" | "light"
  lock: "dark" | "light" | undefined
  active: string
  ready: boolean
}

const [store, setStore] = createStore<State>({
  themes: allThemes(),
  mode: "dark",
  lock: undefined,
  active: "opencode",
  ready: false,
})

subscribeThemes((themes) => setStore("themes", themes))

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light"; source?: ThemeSource }) => {
    const renderer = useRenderer()
    const config = useTuiConfig()
    const kv = useKV()
    const themes = props.source ?? themeSource
    const motryxProduct = isMotryxThemeRestricted()
    const pick = (value: unknown) => {
      if (value === "dark" || value === "light") return value
      return
    }
    const normalizeTheme = (value: unknown) => {
      if (typeof value !== "string") return undefined
      if (!motryxProduct) return value
      return normalizeMotryxThemeName(value)
    }
    const initialTheme = () => {
      if (motryxProduct) {
        return normalizeTheme(config.theme)
          ?? normalizeTheme(kv.get("theme"))
          ?? normalizeTheme(process.env.OPENCODE_IC_AGENT_THEME)
          ?? MOTRYX_DEFAULT_THEME
      }
      const active = config.theme
        ?? process.env.OPENCODE_IC_AGENT_THEME
        ?? (process.env.OPENCODE_IC_AGENT_TUI ? "motryx" : kv.get("theme", "opencode"))
      return normalizeTheme(active) ?? "opencode"
    }

    setStore(
      produce((draft) => {
        const lock = pick(kv.get("theme_mode_lock"))
        const mode = lock ?? pick(renderer.themeMode) ?? props.mode
        if (!lock && pick(kv.get("theme_mode")) !== undefined) kv.set("theme_mode", undefined)
        draft.mode = mode
        draft.lock = lock
        draft.active = initialTheme()
        draft.ready = false
      }),
    )

    createEffect(() => {
      const theme = normalizeTheme(config.theme)
      if (theme) setStore("active", theme)
    })

    function syncCustomThemes() {
      return themes
        .discover()
        .then((themes) => {
          setCustomThemes(
            Object.entries(themes).reduce<Record<string, ThemeJson>>((result, [name, theme]) => {
              if (isTheme(theme)) result[name] = theme
              return result
            }, {}),
          )
        })
        .catch(() => setStore("active", motryxProduct ? MOTRYX_DEFAULT_THEME : "opencode"))
    }

    onMount(() => {
      void Promise.allSettled([resolveSystemTheme(store.mode), syncCustomThemes()]).finally(() => {
        setStore("ready", true)
      })
    })

    let systemThemeSignature: string | undefined
    let systemThemeMode: "dark" | "light" | undefined
    let hasResolvedSystemTheme = false
    function resolveSystemTheme(mode: "dark" | "light" = store.mode) {
      return renderer
        .getPalette({ size: 16 })
        .then((colors: TerminalColors) => {
          if (!colors.palette[0]) {
            if (hasResolvedSystemTheme) return
            setSystemTheme(undefined)
            if (store.active === "system") setStore("active", motryxProduct ? MOTRYX_DEFAULT_THEME : "opencode")
            return
          }
          const next = store.lock ?? terminalMode(colors) ?? mode
          if (store.mode !== next) setStore("mode", next)
          const signature = JSON.stringify(colors)
          hasResolvedSystemTheme = true
          if (store.themes.system && systemThemeSignature === signature && systemThemeMode === next) return
          systemThemeSignature = signature
          systemThemeMode = next
          setSystemTheme(generateSystem(colors, next))
        })
        .catch(() => {
          if (hasResolvedSystemTheme) return
          setSystemTheme(undefined)
          if (store.active === "system") setStore("active", motryxProduct ? MOTRYX_DEFAULT_THEME : "opencode")
        })
    }

    let systemRefreshRunning = false
    let systemRefreshQueued = false
    let systemRefreshMode = store.mode
    function refreshSystemTheme(mode: "dark" | "light" = store.mode) {
      systemRefreshMode = mode
      if (systemRefreshRunning) {
        systemRefreshQueued = true
        return
      }

      systemRefreshRunning = true
      const retry = renderer.paletteDetectionStatus === "detecting"
      renderer.clearPaletteCache()
      void resolveSystemTheme(mode).finally(() => {
        systemRefreshRunning = false
        if (!retry && !systemRefreshQueued) return
        systemRefreshQueued = false
        refreshSystemTheme(systemRefreshMode)
      })
    }

    function apply(mode: "dark" | "light") {
      if (store.lock !== undefined) kv.set("theme_mode", mode)
      if (store.mode === mode) return
      setStore("mode", mode)
      refreshSystemTheme(mode)
    }

    function pin(mode: "dark" | "light" = store.mode) {
      setStore("lock", mode)
      kv.set("theme_mode_lock", mode)
      apply(mode)
    }

    function free() {
      setStore("lock", undefined)
      kv.set("theme_mode_lock", undefined)
      kv.set("theme_mode", undefined)
      refreshSystemTheme(renderer.themeMode ?? store.mode)
    }

    const handle = (mode: "dark" | "light") => {
      if (store.lock) return
      apply(mode)
    }
    renderer.on(CliRenderEvents.THEME_MODE, handle)

    const handleThemeNotification = (sequence: string) => {
      if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") return false
      queueMicrotask(() => refreshSystemTheme())
      return false
    }
    renderer.prependInputHandler(handleThemeNotification)

    let themeRefreshTimeouts: ReturnType<typeof setTimeout>[] = []
    const refresh = () => {
      for (const timeout of themeRefreshTimeouts) clearTimeout(timeout)
      themeRefreshTimeouts = THEME_REFRESH_DELAYS.map((delay) =>
        setTimeout(() => {
          refreshSystemTheme()
          if (delay === THEME_REFRESH_DELAYS[THEME_REFRESH_DELAYS.length - 1]) void syncCustomThemes()
        }, delay),
      )
    }
    let unsubscribeRefresh: (() => void) | undefined
    unsubscribeRefresh = themes.subscribeRefresh?.(refresh)

    onCleanup(() => {
      renderer.off(CliRenderEvents.THEME_MODE, handle)
      renderer.removeInputHandler(handleThemeNotification)
      unsubscribeRefresh?.()
      for (const timeout of themeRefreshTimeouts) clearTimeout(timeout)
      themeRefreshTimeouts.length = 0
    })

    const values = createMemo(() => {
      const themes = motryxProduct ? motryxVisibleThemes(store.themes) : store.themes
      const active = themes[store.active]
      if (active) return resolveTheme(active, store.mode)

      const saved = normalizeTheme(kv.get("theme"))
      if (saved) {
        const theme = themes[saved]
        if (theme) return resolveTheme(theme, store.mode)
      }

      const fallback = motryxProduct ? themes[MOTRYX_DEFAULT_THEME] : store.themes.opencode
      return resolveTheme(fallback ?? store.themes.opencode, store.mode)
    })

    createEffect(() => renderer.setBackgroundColor(values().background))

    const syntax = createSyntaxStyleMemo(() => generateSyntax(values()))
    const subtleSyntax = createSyntaxStyleMemo(() => generateSubtleSyntax(values()))

    return {
      theme: new Proxy(values(), {
        get(_target, prop) {
          // @ts-expect-error Properties are forwarded to the current reactive value.
          return values()[prop]
        },
      }),
      get selected() {
        return store.active
      },
      all: () => motryxProduct ? motryxVisibleThemes(store.themes) : allThemes(),
      has: (theme: string) => {
        const name = normalizeTheme(theme)
        if (!name) return false
        if (motryxProduct) return motryxVisibleThemes(store.themes)[name] !== undefined
        return hasTheme(name)
      },
      syntax,
      subtleSyntax,
      mode: () => store.mode,
      locked: () => store.lock !== undefined,
      lock: () => pin(store.mode),
      unlock: free,
      setMode: pin,
      set(theme: string) {
        const name = normalizeTheme(theme)
        if (!name) return false
        const available = motryxProduct ? motryxVisibleThemes(store.themes) : store.themes
        if (!available[name]) return false
        setStore("active", name)
        kv.set("theme", name)
        return true
      },
      get ready() {
        return store.ready
      },
    }
  },
})

function isMotryxThemeRestricted() {
  if (process.env.OPENCODE_IC_AGENT_TUI === "1" || process.env.OPENCODE_IC_AGENT_TUI === "true") return true
  if (process.env.OPENCODE_IC_AGENT_THEME?.startsWith("motryx")) return true
  return process.env.OPENCODE_ROUTE?.includes('"ic-agent"') ?? false
}

export function createSyntaxStyleMemo(factory: () => SyntaxStyle) {
  const renderer = useRenderer()
  const retained = new Set<SyntaxStyle>()
  let current: SyntaxStyle | undefined

  const release = (style: SyntaxStyle) => {
    retained.add(style)
    void renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!retained.delete(style)) return
        style.destroy()
      })
  }

  onCleanup(() => {
    if (current) release(current)
  })

  return createMemo(() => {
    const previous = current
    current = factory()
    if (previous) release(previous)
    return current
  })
}
