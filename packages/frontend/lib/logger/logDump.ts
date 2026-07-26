import { type LogLevel, type Metadata } from './types'
import { sanitizeLogMessage, sanitizeLogMetadata, sanitizeLogString } from './sanitize'

export type LogEntry = {
  id: string
  timestamp: number
  level: LogLevel
  context: string | undefined
  message: string
  metadata: Metadata
}

type LogEntryInput = Omit<LogEntry, 'message'> & {
  message: string | Error
}

const MAX_ENTRIES = 500
let entries: LogEntry[] = []

export function add(entry: LogEntryInput) {
  entries.push({
    ...entry,
    context: entry.context ? sanitizeLogString(entry.context) : undefined,
    message: sanitizeLogMessage(entry.message),
    metadata: sanitizeLogMetadata(entry.metadata),
  })
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES)
  }
}

export function getEntries(): LogEntry[] {
  // Return newest-first for display
  const result = entries.slice()
  result.reverse()
  return result
}
