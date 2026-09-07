import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("hard kill after Worker admission cannot revive its old Input after reset", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-worker-crash-"))
  const marker = path.join(directory, "admitted.json")
  const fixture = path.join(import.meta.dir, "fixture/worker-input-crash.ts")
  const child = Bun.spawn([process.execPath, fixture, "admit", path.join(directory, "host.sqlite"), marker], {
    stdout: "pipe", stderr: "pipe",
  })
  try {
    const deadline = Date.now() + 30_000
    while (!await Bun.file(marker).exists()) {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text())
      expect(Date.now()).toBeLessThan(deadline)
      await Bun.sleep(50)
    }
    child.kill("SIGKILL")
    await child.exited
    expect(child.signalCode).toBe("SIGKILL")
    const successor = Bun.spawn([process.execPath, fixture, "reset", path.join(directory, "host.sqlite"), marker], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    })
    const [code, stdout, stderr] = await Promise.all([
      successor.exited, new Response(successor.stdout).text(), new Response(successor.stderr).text(),
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout).toContain("PASS: worker admission survives crash")
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 65_000)
