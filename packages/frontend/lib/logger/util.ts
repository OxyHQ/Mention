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

export { formatRelativeTimeCompact as timeAgo } from '@/utils/dateUtils'
