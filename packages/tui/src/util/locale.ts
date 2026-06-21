export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const hours = Math.floor(input / 3600000)
  const days = Math.floor((input % 3600000) / 86400000)
  return `${days}d ${hours}h`
}

const ellipsis = "…"
const ellipsisWidth = displayWidth(ellipsis)
const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

export function displayWidth(str: string): number {
  return Bun.stringWidth(str)
}

function graphemes(str: string): string[] {
  if (!graphemeSegmenter) return Array.from(str)
  return Array.from(graphemeSegmenter.segment(str), (part) => part.segment)
}

function takeStartByDisplayWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  let width = 0
  let result = ""
  for (const segment of graphemes(str)) {
    const nextWidth = width + displayWidth(segment)
    if (nextWidth > maxWidth) break
    result += segment
    width = nextWidth
  }
  return result
}

function takeEndByDisplayWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  let width = 0
  const result: string[] = []
  const segments = graphemes(str)
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!
    const nextWidth = width + displayWidth(segment)
    if (nextWidth > maxWidth) break
    result.unshift(segment)
    width = nextWidth
  }
  return result.join("")
}

export function truncate(str: string, len: number): string {
  if (displayWidth(str) <= len) return str
  if (len <= 0) return ""
  if (len < ellipsisWidth) return takeStartByDisplayWidth(str, len)
  return takeStartByDisplayWidth(str, len - ellipsisWidth) + ellipsis
}

export function truncateLeft(str: string, len: number): string {
  if (displayWidth(str) <= len) return str
  if (len <= 0) return ""
  if (len < ellipsisWidth) return takeEndByDisplayWidth(str, len)
  return ellipsis + takeEndByDisplayWidth(str, len - ellipsisWidth)
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (displayWidth(str) <= maxLength) return str
  if (maxLength <= 0) return ""
  if (maxLength < ellipsisWidth) return takeStartByDisplayWidth(str, maxLength)

  const keepWidth = maxLength - ellipsisWidth
  const keepStart = Math.ceil(keepWidth / 2)
  const keepEnd = Math.floor(keepWidth / 2)

  return takeStartByDisplayWidth(str, keepStart) + ellipsis + takeEndByDisplayWidth(str, keepEnd)
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"
