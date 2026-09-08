import { expect, test } from "bun:test"
import {
  motryxModelSetArgv,
  motryxModelSetCommandFromEnv,
  setMotryxModelTier,
  parseMotryxModelApplication,
} from "../../src/feature-plugins/motryx/model-config"

const expected = { sessionID: "ses_current", serverGeneration: "gen_1", bindingGeneration: 2, ownerRunID: "run_1" }

test("Motryx model tier selection accepts only an exact launcher argv", () => {
  const result = motryxModelSetCommandFromEnv({
    MOTRYX_PROJECT_DIR: "/tmp/project",
    MOTRYX_MODEL_SET_COMMAND_JSON: JSON.stringify([
      "/runtime/scripts/motryx.sh",
      "--project",
      "/tmp/project",
      "models",
      "set",
    ]),
  })
  expect(result).toEqual({
    ok: true,
    value: {
      argv: ["/runtime/scripts/motryx.sh", "--project", "/tmp/project", "models", "set"],
      projectID: "/tmp/project",
    },
  })
  if (!result.ok) throw new Error(result.error)
  expect(motryxModelSetArgv(result.value, "weak", "provider/family/model", expected)).toEqual([
    "/runtime/scripts/motryx.sh",
    "--project",
    "/tmp/project",
    "models",
    "set",
    "weak",
    "provider/family/model",
    "--json",
    "--expected-route",
    JSON.stringify({ serverGeneration: "gen_1", currentSessionID: "ses_current", bindingGeneration: 2, ownerRunID: "run_1" }),
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
    setMotryxModelTier({ argv: ["/usr/bin/true"], projectID: "/tmp" }, "strong", "provider/model", { expected }),
  ).rejects.toThrow("exit 0")
  await expect(
    setMotryxModelTier({ argv: ["/usr/bin/false"], projectID: "/tmp" }, "weak", "provider/model", { expected }),
  ).rejects.toThrow("exit 1")

  const controller = new AbortController()
  controller.abort()
  await expect(
    setMotryxModelTier({ argv: ["/usr/bin/true"], projectID: "/tmp" }, "strong", "provider/model", {
      expected,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled")
})

function response(status = "accepted", applied = false) {
  return { status: "ok", tier: "strong", modelPolicy: { strong: { model: "provider/saved", variant: "default" } },
    application: { status, schemaVersion: 11, tier: "strong", selection: { model: "provider/latest", variant: "high" },
      accepted: [{ sessionID: "ses_1", role: "orchestrator", applied }], unconfirmed: [] } }
}

test("setter response distinguishes effective selection, pending, applied and partial failure", () => {
  expect(parseMotryxModelApplication(response(), "strong")).toMatchObject({
    selection: { model: "provider/latest", variant: "high" }, accepted: [{ applied: false }] })
  expect(parseMotryxModelApplication(response("accepted", true), "strong").accepted[0]?.applied).toBe(true)
  const partial = response("partial")
  const value = { ...partial, application: { ...partial.application,
    unconfirmed: [{ sessionID: "ses_2", role: "analyst", message: "Host unavailable" }] } }
  expect(parseMotryxModelApplication(value, "strong").status).toBe("partial")
  expect(() => parseMotryxModelApplication(partial, "strong")).toThrow("Inconsistent")
  expect(() => parseMotryxModelApplication(response(), "weak")).toThrow()
  expect(() => parseMotryxModelApplication({ ...response(), application: { ...response().application,
    accepted: [{ sessionID: "ses_1", role: "orchestrator" }] } }, "strong")).toThrow()
})

test("real setter subprocess returns partial JSON on exit 1 and cannot inherit control credentials", async () => {
  const result = response("partial")
  const body = { ...result, application: { ...result.application,
    unconfirmed: [{ sessionID: "ses_2", role: "analyst", message: "Host unavailable" }] } }
  const script = `
    for (const key of ["MOTRYX_CONTROL_API_TOKEN", "MOTRYX_BINDING_TOKEN", "MOTRYX_CONTROLLER_TOKEN"])
      if (process.env[key]) throw new Error("inherited control credential");
    if (!process.argv.includes("--expected-route")) throw new Error("missing expected route");
    console.error("diagnostic must not corrupt stdout JSON");
    console.log(${JSON.stringify(JSON.stringify(body))});
    process.exitCode = 1;
  `
  const applied = await setMotryxModelTier({ argv: [process.execPath, "-e", script, "--"], projectID: "/tmp" },
    "strong", "provider/requested", { expected, env: { ...process.env,
      MOTRYX_CONTROL_API_TOKEN: "test-control", MOTRYX_BINDING_TOKEN: "test-binding", MOTRYX_CONTROLLER_TOKEN: "test-host" } })
  expect(applied).toMatchObject({ status: "partial", selection: { model: "provider/latest", variant: "high" } })
  expect(applied.unconfirmed[0]?.sessionID).toBe("ses_2")
})
