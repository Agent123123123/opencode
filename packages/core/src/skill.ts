export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "node:path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillBundle } from "./skill/bundle"
import { SkillDiscovery } from "./skill/discovery"
import { SkillResource } from "./skill/resource"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

type Storage =
  | { type: "filesystem"; sourceRoot: string; entry: string }
  | { type: "bundle"; bundle: Skill.Bundle; entry: string }
  | { type: "embedded" }

type Loaded = {
  info: Info
  storage: Storage
}

export type Data = {
  sources: Types.DeepMutable<Source>[]
  bundles: Skill.Bundle[]
}

export type Draft = {
  source: (source: Source) => void
  bundle: (bundle: Skill.Bundle) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly base: (name: string) => Effect.Effect<string>
  readonly listFiles: (name: string, limit: number) => Effect.Effect<string[]>
  readonly readResource: (name: string, resourcePath: string) => Effect.Effect<{ path: string; content: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [], bundles: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        bundle: (input) => {
          const bundle = SkillBundle.validate(input)
          const existing = draft.bundles.find((item) => item.id === bundle.id)
          if (existing) throw new Error(`duplicate skill bundle id: ${bundle.id}`)
          draft.bundles.push(bundle)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const loadSource = Effect.fn("SkillV2.loadSource")(function* (source: Source) {
      if (source.type === "embedded") return [{ info: source.skill, storage: { type: "embedded" } }] satisfies Loaded[]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      const skills: Loaded[] = []
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            info: {
              name,
              description: frontmatter.description,
              slash: frontmatter.slash,
              location: AbsolutePath.make(filepath),
              content: markdown.content,
            },
            storage: { type: "filesystem", sourceRoot: directory, entry: filepath },
          })
        }
      }
      return skills
    })

    const loadBundle = Effect.fn("SkillV2.loadBundle")(function* (bundle: Skill.Bundle) {
      const skills: Loaded[] = []
      for (const entry of bundle.entries) {
        const markdown = ConfigMarkdown.parseOption(bundle.files[entry]!)
        const frontmatter = markdown ? decodeFrontmatter(markdown.data).valueOrUndefined : undefined
        if (!markdown || !frontmatter?.name) {
          return yield* Effect.die(`invalid skill bundle frontmatter: ${SkillBundle.location(bundle.id, entry)}`)
        }
        skills.push({
          info: {
            name: frontmatter.name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(SkillBundle.location(bundle.id, entry)),
            content: markdown.content,
          },
          storage: { type: "bundle", bundle, entry },
        })
      }
      return skills
    })

    const sourceCache = new Map<string, Loaded[]>()
    const bundleCache = new Map<string, Loaded[]>()
    const warnedCollisions = new Set<string>()
    const current = Effect.fn("SkillV2.current")(function* () {
      const skills = new Map<string, Loaded>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = sourceCache.get(key) ?? (yield* loadSource(source))
        sourceCache.set(key, loaded)
        for (const skill of loaded) {
          const existing = skills.get(skill.info.name)
          if (existing) {
            const warning = `${skill.info.name}\0${existing.info.location}\0${skill.info.location}`
            if (!warnedCollisions.has(warning)) {
              warnedCollisions.add(warning)
              yield* Effect.logWarning("duplicate filesystem skill name", {
                name: skill.info.name,
                existing: existing.info.location,
                duplicate: skill.info.location,
              })
            }
          }
          skills.set(skill.info.name, skill)
        }
      }
      for (const bundle of state.get().bundles) {
        const key = `${bundle.id}:${bundle.digest}`
        const loaded = bundleCache.get(key) ?? (yield* loadBundle(bundle))
        bundleCache.set(key, loaded)
        for (const skill of loaded) {
          const existing = skills.get(skill.info.name)
          if (existing?.storage.type === "bundle") {
            return yield* Effect.die(
              `duplicate plugin bundle skill ${skill.info.name}: ${existing.info.location}, ${skill.info.location}`,
            )
          }
          if (existing) {
            const warning = `${skill.info.name}\0${existing.info.location}\0${skill.info.location}`
            if (!warnedCollisions.has(warning)) {
              warnedCollisions.add(warning)
              yield* Effect.logWarning("bundle skill overrides existing skill", {
                name: skill.info.name,
                existing: existing.info.location,
                bundle: skill.info.location,
              })
            }
          }
          skills.set(skill.info.name, skill)
        }
      }
      return skills
    })

    const requireLoaded = Effect.fn("SkillV2.requireLoaded")(function* (name: string) {
      const loaded = (yield* current()).get(name)
      if (!loaded) return yield* Effect.die(`skill not found: ${name}`)
      return loaded
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list: Effect.fn("SkillV2.list")(function* () {
        return [...(yield* current()).values()].map((skill) => skill.info)
      }),
      base: Effect.fn("SkillV2.base")(function* (name) {
        const loaded = yield* requireLoaded(name)
        if (loaded.storage.type === "bundle") return SkillBundle.base(loaded.storage.bundle.id, loaded.storage.entry)
        return path.dirname(loaded.info.location)
      }),
      listFiles: Effect.fn("SkillV2.listFiles")(function* (name, limit) {
        const loaded = yield* requireLoaded(name)
        const storage = loaded.storage
        if (storage.type === "embedded") return []
        if (storage.type === "bundle") {
          return SkillBundle.listFiles(storage.bundle, storage.entry, limit).map((resource) =>
            SkillBundle.location(
              storage.bundle.id,
              path.posix.normalize(path.posix.join(path.posix.dirname(storage.entry), resource)),
            ),
          )
        }
        const directory = path.dirname(storage.entry)
        return (yield* fs
          .glob("**/*", {
            cwd: directory,
            absolute: true,
            include: "file",
            dot: true,
            symlink: false,
          })
          .pipe(Effect.orDie))
          .filter((file) => file !== storage.entry)
          .toSorted()
          .slice(0, limit)
      }),
      readResource: Effect.fn("SkillV2.readResource")(function* (name, resourcePath) {
        const loaded = yield* requireLoaded(name)
        if (loaded.storage.type === "embedded") return yield* Effect.die(`embedded skill ${name} has no resources`)
        if (loaded.storage.type === "bundle") {
          const resource = SkillBundle.readResource(loaded.storage.bundle, loaded.storage.entry, resourcePath)
          return {
            path: SkillBundle.location(loaded.storage.bundle.id, resource.path),
            content: resource.content,
          }
        }
        const candidate = SkillResource.resolveFilesystem(loaded.storage.sourceRoot, loaded.storage.entry, resourcePath)
        const sourceRoot = yield* fs.resolve(loaded.storage.sourceRoot)
        const target = SkillResource.validateResolvedFilesystem(sourceRoot, yield* fs.resolve(candidate), resourcePath)
        const info = yield* fs.stat(target).pipe(Effect.orDie)
        if (info.type !== "File") return yield* Effect.die(`skill resource is not a regular file: ${resourcePath}`)
        if (info.size > SkillResource.maxBytes) {
          return yield* Effect.die(`skill resource exceeds ${SkillResource.maxBytes} bytes: ${resourcePath}`)
        }
        const content = SkillResource.decodeUtf8(yield* fs.readFile(target).pipe(Effect.orDie), resourcePath)
        return { path: target, content }
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
