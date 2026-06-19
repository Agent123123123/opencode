import { open } from "node:fs/promises"

const MAX_PREVIEW_BYTES = 1024 * 1024

export type IcArtifactPreview = {
  path: string
  title: string
  available: boolean
  content: string
  truncated: boolean
  size: number
  error?: string
}

export async function readArtifactPreview(input: { path: string; title: string }): Promise<IcArtifactPreview> {
  try {
    const file = await open(input.path, "r")
    try {
      const stat = await file.stat()
      const limit = Math.min(stat.size, MAX_PREVIEW_BYTES)
      const buffer = Buffer.alloc(limit)
      const result = await file.read(buffer, 0, limit, 0)
      const truncated = stat.size > result.bytesRead
      const content = buffer.subarray(0, result.bytesRead).toString("utf8")
      return {
        path: input.path,
        title: input.title,
        available: true,
        content: truncated
          ? `${content}\n\n[IC Agent TUI preview truncated at ${formatBytes(result.bytesRead)} of ${formatBytes(stat.size)}]`
          : content,
        truncated,
        size: stat.size,
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    return {
      path: input.path,
      title: input.title,
      available: false,
      content: "",
      truncated: false,
      size: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
