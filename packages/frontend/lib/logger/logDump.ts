import { type LogLevel, type Metadata } from './types'

export type LogEntry = {
  id: string
  timestamp: number
  level: LogLevel
  context: string | undefined
  message: string | Error
  metadata: Metadata
}

const MAX_ENTRIES = 500
let entries: LogEntry[] = []

export function add(entry: LogEntry) {
  entries.push(entry)
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
