export * as SkillResource from "./resource"

import path from "node:path"
import { FSUtil } from "../fs-util"

export const maxBytes = 1024 * 1024

export function resolveFilesystem(sourceRoot: string, entry: string, resourcePath: string): string {
  if (
    !resourcePath ||
    resourcePath.includes("\\") ||
    resourcePath.includes("\0") ||
    path.isAbsolute(resourcePath) ||
    path.win32.isAbsolute(resourcePath) ||
    URL.canParse(resourcePath)
  ) throw new Error(`invalid skill resource path: ${resourcePath || "<empty>"}`)
  const target = path.resolve(path.dirname(entry), resourcePath)
  if (!FSUtil.contains(sourceRoot, target) || target === sourceRoot) {
    throw new Error(`skill resource escapes discovery root: ${resourcePath}`)
  }
  return target
}

export function validateResolvedFilesystem(sourceRoot: string, target: string, resourcePath: string): string {
  if (!FSUtil.contains(sourceRoot, target) || target === sourceRoot) {
    throw new Error(`skill resource escapes discovery root through symlink: ${resourcePath}`)
  }
  return target
}

export function decodeUtf8(bytes: Uint8Array, resourcePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`skill resource is not valid UTF-8: ${resourcePath}`)
  }
}
