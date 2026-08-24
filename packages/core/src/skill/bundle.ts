export * as SkillBundle from "./bundle"

import { createHash } from "node:crypto"
import path from "node:path"
import { Skill } from "@opencode-ai/schema/skill"

const maxFileBytes = 1024 * 1024
const maxBundleBytes = 4 * 1024 * 1024

export function validate(input: Skill.Bundle): Skill.Bundle {
  if (input.schema !== "opencode.skill_bundle.v1") throw new Error(`unsupported skill bundle schema: ${input.schema}`)
  if (!/^[A-Za-z0-9._-]+$/.test(input.id)) throw new Error(`invalid skill bundle id: ${input.id}`)
  if (!/^[a-f0-9]{64}$/.test(input.digest)) throw new Error(`invalid skill bundle digest: ${input.id}`)

  const files = Object.fromEntries(
    Object.entries(input.files)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([resource, content]) => {
        if (!safePayloadPath(resource)) throw new Error(`invalid skill bundle path in ${input.id}: ${resource}`)
        if (typeof content !== "string") throw new Error(`non-text skill bundle resource in ${input.id}: ${resource}`)
        if (Buffer.byteLength(content) > maxFileBytes) {
          throw new Error(`skill bundle resource exceeds ${maxFileBytes} bytes in ${input.id}: ${resource}`)
        }
        return [resource, content]
      }),
  )
  const bytes = Object.values(files).reduce((total, content) => total + Buffer.byteLength(content), 0)
  if (bytes > maxBundleBytes) throw new Error(`skill bundle ${input.id} exceeds ${maxBundleBytes} bytes`)

  const entries = input.entries.toSorted()
  if (new Set(entries).size !== entries.length) throw new Error(`duplicate skill bundle entry in ${input.id}`)
  for (const entry of entries) {
    if (!safePayloadPath(entry) || path.posix.basename(entry) !== "SKILL.md" || files[entry] === undefined) {
      throw new Error(`invalid skill bundle entry in ${input.id}: ${entry}`)
    }
  }

  const canonical = JSON.stringify({ schema: input.schema, id: input.id, entries, files })
  const digest = createHash("sha256").update(canonical).digest("hex")
  if (digest !== input.digest) throw new Error(`skill bundle digest mismatch for ${input.id}`)
  return { ...input, entries, files }
}

export function location(bundleID: string, entry: string): string {
  return `skill://${bundleID}/${entry}`
}

export function base(bundleID: string, entry: string): string {
  const directory = path.posix.dirname(entry)
  return `skill://${bundleID}${directory === "." ? "" : `/${directory}`}`
}

export function listFiles(bundle: Skill.Bundle, entry: string, limit: number): string[] {
  const directory = path.posix.dirname(entry)
  return Object.keys(bundle.files)
    .filter((resource) => resource !== entry)
    .map((resource) => path.posix.relative(directory, resource))
    .toSorted()
    .slice(0, limit)
}

export function readResource(bundle: Skill.Bundle, entry: string, resourcePath: string): {
  path: string
  content: string
} {
  if (
    !resourcePath ||
    resourcePath.includes("\\") ||
    resourcePath.includes("\0") ||
    path.posix.isAbsolute(resourcePath) ||
    path.win32.isAbsolute(resourcePath) ||
    URL.canParse(resourcePath)
  ) throw new Error(`invalid skill resource path: ${resourcePath || "<empty>"}`)
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), resourcePath))
  if (!safePayloadPath(target)) throw new Error(`skill resource escapes bundle ${bundle.id}: ${resourcePath}`)
  const content = bundle.files[target]
  if (content === undefined) throw new Error(`skill resource not found in ${bundle.id}: ${resourcePath}`)
  return { path: target, content }
}

function safePayloadPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !URL.canParse(value) &&
    path.posix.normalize(value) === value &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  )
}
