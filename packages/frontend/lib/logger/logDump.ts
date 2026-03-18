import { type LogContext, type LogLevel, type Metadata } from './types'

export type LogEntry = {
  id: string
  timestamp: number
  level: LogLevel
  context: LogContext | undefined
  message: string | Error
  metadata: Metadata
}

let entries: LogEntry[] = []

export function add(entry: LogEntry) {
  entries.unshift(entry)
  entries = entries.slice(0, 500)
}

export function getEntries(): LogEntry[] {
  return entries
}
