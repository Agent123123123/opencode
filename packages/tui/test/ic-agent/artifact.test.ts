import { expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readArtifactPreview } from "../../src/ic-agent/artifact"

test("reads a bounded artifact preview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-artifact-"))
  try {
    const file = path.join(root, "coverage.md")
    writeFileSync(file, "# Coverage\nAll bins closed.\n")

    const preview = await readArtifactPreview({ path: file, title: "coverage.md" })

    expect(preview).toMatchObject({
      path: file,
      title: "coverage.md",
      available: true,
      content: "# Coverage\nAll bins closed.\n",
      truncated: false,
      size: 28,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("returns an unavailable preview instead of throwing for missing artifacts", async () => {
  const preview = await readArtifactPreview({
    path: "/tmp/ic-agent-artifact-missing/does-not-exist.log",
    title: "does-not-exist.log",
  })

  expect(preview.available).toBe(false)
  expect(preview.content).toBe("")
  expect(preview.truncated).toBe(false)
  expect(preview.error?.toLowerCase()).toContain("no such file")
})

test("marks large artifact previews as truncated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ic-agent-artifact-"))
  try {
    mkdirSync(path.join(root, "logs"), { recursive: true })
    const file = path.join(root, "logs", "compile.log")
    writeFileSync(file, `${"a".repeat(1024 * 1024 + 16)}\n`)

    const preview = await readArtifactPreview({ path: file, title: "compile.log" })

    expect(preview.available).toBe(true)
    expect(preview.truncated).toBe(true)
    expect(preview.size).toBe(1024 * 1024 + 17)
    expect(preview.content).toContain("[IC Agent TUI preview truncated")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
