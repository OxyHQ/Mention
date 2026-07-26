import { type Metadata, type Serializable } from './types'
import { sanitizeLogMetadata } from './sanitize'

export function prepareMetadata(
  metadata: Metadata,
): Record<string, Serializable> {
  return sanitizeLogMetadata(metadata) as Record<string, Serializable>
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

export { formatTimeAgo as timeAgo } from '@/utils/dateUtils'
