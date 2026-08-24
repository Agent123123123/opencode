import fs from "fs/promises"
import { createHash } from "node:crypto"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("loads a plugin bundle and reads shared resources without filesystem materialization", () =>
    Effect.gen(function* () {
      const files = {
        "reference/shared.md": "shared reference",
        "verification/SKILL.md": "---\nname: verification\ndescription: Verify\n---\n# Verify",
      }
      const entries = ["verification/SKILL.md"]
      const digest = createHash("sha256")
        .update(JSON.stringify({ schema: "opencode.skill_bundle.v1", id: "motryx.dv", entries, files }))
        .digest("hex")
      const skill = yield* SkillV2.Service
      yield* skill.transform((draft) =>
        draft.bundle({ schema: "opencode.skill_bundle.v1", id: "motryx.dv", digest, entries, files }),
      )

      expect(yield* skill.list()).toEqual([
        expect.objectContaining({
          name: "verification",
          location: "skill://motryx.dv/verification/SKILL.md",
          content: "# Verify",
        }),
      ])
      expect(yield* skill.base("verification")).toBe("skill://motryx.dv/verification")
      expect(yield* skill.listFiles("verification", 10)).toEqual(["skill://motryx.dv/reference/shared.md"])
      expect(yield* skill.readResource("verification", "../reference/shared.md")).toEqual({
        path: "skill://motryx.dv/reference/shared.md",
        content: "shared reference",
      })
    }),
  )

  it.live("rejects duplicate bundle IDs", () =>
    Effect.gen(function* () {
      const files = {
        "verification/SKILL.md": "---\nname: verification\ndescription: Verify\n---\n# Verify",
      }
      const entries = ["verification/SKILL.md"]
      const digest = createHash("sha256")
        .update(JSON.stringify({ schema: "opencode.skill_bundle.v1", id: "motryx.dv", entries, files }))
        .digest("hex")
      const bundle = { schema: "opencode.skill_bundle.v1" as const, id: "motryx.dv", digest, entries, files }
      const skill = yield* SkillV2.Service
      yield* skill.transform((draft) => draft.bundle(bundle))
      const duplicate = yield* skill.transform((draft) => draft.bundle(bundle)).pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      if (Exit.isFailure(duplicate)) expect(Cause.pretty(duplicate.cause)).toContain("duplicate skill bundle id")
    }),
  )

  it.live("rejects duplicate names from different plugin bundles", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      for (const id of ["first.bundle", "second.bundle"]) {
        const files = {
          [`${id}/SKILL.md`]: `---\nname: verification\ndescription: ${id}\n---\n# ${id}`,
        }
        const entries = [`${id}/SKILL.md`]
        const digest = createHash("sha256")
          .update(JSON.stringify({ schema: "opencode.skill_bundle.v1", id, entries, files }))
          .digest("hex")
        yield* skill.transform((draft) =>
          draft.bundle({ schema: "opencode.skill_bundle.v1", id, digest, entries, files }),
        )
      }
      const duplicate = yield* skill.list().pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)
      if (Exit.isFailure(duplicate)) {
        expect(Cause.pretty(duplicate.cause)).toContain("duplicate plugin bundle skill verification")
      }
    }),
  )

  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("rejects filesystem resource symlink escapes and invalid UTF-8", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const directory = path.join(source, "secure")
          const outside = path.join(tmp.path, "outside.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(directory, { recursive: true })
            await write(source, "secure", "Secure")
            await fs.writeFile(outside, "secret")
            await fs.symlink(outside, path.join(directory, "escape.txt"))
            await fs.writeFile(path.join(directory, "invalid.bin"), new Uint8Array([0xff]))
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(source) }))

          const escaped = yield* skill.readResource("secure", "escape.txt").pipe(Effect.exit)
          expect(Exit.isFailure(escaped)).toBe(true)
          if (Exit.isFailure(escaped)) expect(Cause.pretty(escaped.cause)).toContain("escapes discovery root")

          const invalid = yield* skill.readResource("secure", "invalid.bin").pipe(Effect.exit)
          expect(Exit.isFailure(invalid)).toBe(true)
          if (Exit.isFailure(invalid)) expect(Cause.pretty(invalid.cause)).toContain("not valid UTF-8")
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )
})
