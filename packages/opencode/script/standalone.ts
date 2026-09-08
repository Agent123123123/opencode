import { $ } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const dir = path.resolve(import.meta.dirname, "..")
const workerPath = "./src/cli/tui/worker.ts"
const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"

export type PreparedStandaloneBuild = Awaited<ReturnType<typeof prepareStandaloneBuild>>

export async function prepareStandaloneBuild(input: { skipEmbedWebUi: boolean }) {
  const generated = await import("./generate.ts")
  const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()
  const embeddedWebUi = input.skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

  return {
    entrypoints: [
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedWebUi ? ["opencode-web-ui.gen.ts"] : []),
    ],
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedWebUi ? { "opencode-web-ui.gen.ts": embeddedWebUi } : {}),
    },
    modelsData: generated.modelsData,
  }
}

export async function compileStandalone(input: {
  prepared: PreparedStandaloneBuild
  entrypoint: string
  outfile: string
  target: string
  opencodeVersion: string
  userAgentVersion: string
  channel: string
  userAgent: string
  os: string
  abi?: "musl"
  sourcemap?: boolean
  autoloadTsconfig?: boolean
  autoloadPackageJson?: boolean
  define?: Record<string, string>
}) {
  const priorCwd = process.cwd()
  process.chdir(dir)
  try {
    const bunfsRoot = input.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
    const result = await Bun.build({
      conditions: ["bun", "node"],
      tsconfig: "./tsconfig.json",
      plugins: [createSolidTransformPlugin()],
      external: ["node-gyp"],
      format: "esm",
      minify: true,
      sourcemap: input.sourcemap ? "linked" : "none",
      splitting: true,
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: input.autoloadTsconfig ?? true,
        autoloadPackageJson: input.autoloadPackageJson ?? true,
        target: input.target as never,
        outfile: input.outfile,
        execArgv: [`--user-agent=${input.userAgent}/${input.userAgentVersion}`, "--use-system-ca", "--"],
        windows: {},
      },
      files: input.prepared.files,
      entrypoints: [input.entrypoint, ...input.prepared.entrypoints],
      define: {
        FFF_LIBC: JSON.stringify(input.abi === "musl" ? "musl" : "gnu"),
        OPENCODE_VERSION: JSON.stringify(input.opencodeVersion),
        OPENCODE_USER_AGENT: JSON.stringify(`${input.userAgent}/${input.userAgentVersion}`),
        OPENCODE_MODELS_DEV: input.prepared.modelsData,
        OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(bunfsRoot + treeSitterWorkerPath),
        OPENCODE_WORKER_PATH: JSON.stringify(workerPath),
        OPENCODE_CHANNEL: JSON.stringify(input.channel),
        OPENCODE_LIBC: input.os === "linux" ? JSON.stringify(input.abi ?? "glibc") : "undefined",
        ...(input.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(input.abi ?? "glibc") } : {}),
        ...input.define,
      },
    })
    if (result.success) return result
    throw new AggregateError(result.logs, "standalone build failed")
  } finally {
    process.chdir(priorCwd)
  }
}

async function createEmbeddedWebUIBundle() {
  console.log("Building Web UI to embed in the binary")
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  const { Script } = await import("@opencode-ai/script")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, index) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${index} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  return [
    ...imports,
    "export default {",
    ...files.map((file, index) => `  ${JSON.stringify(file)}: file_${index},`),
    "}",
  ].join("\n")
}
