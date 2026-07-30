/**
 * Mention's transport configuration for the shared `@oxyhq/core/logger`.
 *
 * The logger itself is the SDK's — call sites import `logger` /
 * `createLogger` straight from `@oxyhq/core/logger`. This module only owns the
 * two app-level policies the SDK deliberately leaves to the consumer:
 *
 *  1. **Scrubbing.** Every entry passes through `sanitizeLogEntry` before it
 *     reaches the console, so credentials, emails, handles, URLs and record
 *     ids never land in a log line, however they were interpolated.
 *  2. **Level.** `EXPO_PUBLIC_LOG_LEVEL` wins; a namespace filter in
 *     `EXPO_PUBLIC_LOG_DEBUG` implies `debug`; otherwise `info` in development
 *     and `silent` in production — production builds have never shipped log
 *     output and keeping that is the conservative default.
 */
import {
  configureLogger,
  consoleSink,
  isDev,
  type LogLevel,
  type LogSink,
} from '@oxyhq/core/logger'

import { LOG_DEBUG_FILTER, LOG_LEVEL } from '@/config'
import { sanitizeLogEntry } from './sanitize'

/**
 * `EXPO_PUBLIC_LOG_DEBUG` is a comma-separated list of namespace globs
 * (`feed,useDrafts:*`). When set, only matching namespaces emit `debug`.
 */
const DEBUG_NAMESPACE_MATCHERS = LOG_DEBUG_FILTER
  ? LOG_DEBUG_FILTER.split(',').map(
      (filter) => new RegExp(filter.replace(/[^\w:*-]/g, '').replace(/\*/g, '.*')),
    )
  : []

function debugAllowed(namespace: string | undefined): boolean {
  if (DEBUG_NAMESPACE_MATCHERS.length === 0) return true
  if (!namespace) return true
  return DEBUG_NAMESPACE_MATCHERS.some((matcher) => matcher.test(namespace))
}

function resolveLevel(): LogLevel {
  if (LOG_LEVEL) return LOG_LEVEL
  if (DEBUG_NAMESPACE_MATCHERS.length > 0) return 'debug'
  return isDev() ? 'info' : 'silent'
}

export const appLogSink: LogSink = (entry) => {
  if (entry.level === 'debug' && !debugAllowed(entry.namespace)) return
  consoleSink(sanitizeLogEntry(entry))
}

/** Install Mention's level + scrubbing sink on the shared SDK logger. */
export function configureAppLogging(): void {
  configureLogger({ level: resolveLevel(), sink: appLogSink })
}
