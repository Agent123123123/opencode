import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(file)
    return /\.tsx?$/.test(entry.name) ? [file] : []
  })
}

test("the narrow V2 TUI adapter does not grow worker-control or session-selection parity", () => {
  const root = path.join(import.meta.dir, "../src")
  const source = sourceFiles(root)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
    .replaceAll(/\s+/g, "")

  for (const forbidden of [
    "client.v2.agent",
    "client.v2.command",
    "client.v2.integration.list",
    "client.v2.integration.get",
    "client.v2.provider",
    "client.v2.skill",
    "client.v2.session.list",
    "client.v2.session.switchAgent",
    "client.v2.session.switchModel",
    'case"catalog.updated"',
    'case"integration.updated"',
  ]) {
    expect(source).not.toContain(forbidden)
  }
})
