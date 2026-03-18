import { type Metadata, type Serializable } from './types'

export function prepareMetadata(
  metadata: Metadata,
): Record<string, Serializable> {
  const result: Record<string, Serializable> = {}
  for (const key of Object.keys(metadata)) {
    let value = metadata[key]
    if (value instanceof Error) {
      value = value.toString()
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 0 &&
      value.constructor === Object
    ) {
      continue
    }
    result[key] = value as Serializable
  }
  return result
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
