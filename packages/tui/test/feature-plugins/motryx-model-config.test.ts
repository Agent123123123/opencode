import { expect, test } from "bun:test"
import {
  motryxModelSetArgv,
  motryxModelSetCommandFromEnv,
  setMotryxModelTier,
} from "../../src/feature-plugins/motryx/model-config"

test("Motryx model tier selection accepts only an exact launcher argv", () => {
  const result = motryxModelSetCommandFromEnv({
    MOTRYX_PROJECT_DIR: "/tmp/project",
    MOTRYX_MODEL_SET_COMMAND_JSON: JSON.stringify([
      "/runtime/scripts/motryx.sh",
      "--project",
      "/tmp/project",
      "models",
      "set",
      "--defer-refresh",
    ]),
  })
  expect(result).toEqual({
    ok: true,
    value: {
      argv: ["/runtime/scripts/motryx.sh", "--project", "/tmp/project", "models", "set", "--defer-refresh"],
      projectID: "/tmp/project",
    },
  })
  if (!result.ok) throw new Error(result.error)
  expect(motryxModelSetArgv(result.value, "weak", "provider/family/model")).toEqual([
    "/runtime/scripts/motryx.sh",
    "--project",
    "/tmp/project",
    "models",
    "set",
    "--defer-refresh",
    "weak",
    "provider/family/model",
  ])

  expect(
    motryxModelSetCommandFromEnv({
      MOTRYX_PROJECT_DIR: "/tmp/project",
      MOTRYX_MODEL_SET_COMMAND_JSON: '["motryx"]',
    }),
  ).toEqual({ ok: false, error: "MOTRYX_MODEL_SET_COMMAND_JSON executable must be absolute" })
  expect(motryxModelSetCommandFromEnv({ MOTRYX_PROJECT_DIR: "/tmp/project" })).toEqual({
    ok: false,
    error: "MOTRYX_MODEL_SET_COMMAND_JSON is missing",
  })
})

test("Motryx model tier selection executes argv directly and reports command failure", async () => {
  await expect(
    setMotryxModelTier({ argv: ["/usr/bin/true"], projectID: "/tmp" }, "strong", "provider/model"),
  ).resolves.toBeUndefined()
  await expect(
    setMotryxModelTier({ argv: ["/usr/bin/false"], projectID: "/tmp" }, "weak", "provider/model"),
  ).rejects.toThrow("exit 1")

  const controller = new AbortController()
  controller.abort()
  await expect(
    setMotryxModelTier({ argv: ["/usr/bin/true"], projectID: "/tmp" }, "strong", "provider/model", {
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled")
})
