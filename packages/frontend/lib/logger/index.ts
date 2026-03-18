import { add } from './logDump'
import { consoleTransport } from './transports/console'
import {
  LogContext,
  LogLevel,
  type Metadata,
  type Transport,
} from './types'

const TRANSPORTS: Transport[] = __DEV__ ? [consoleTransport] : []

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  [LogLevel.Debug]: 0,
  [LogLevel.Info]: 1,
  [LogLevel.Log]: 2,
  [LogLevel.Warn]: 3,
  [LogLevel.Error]: 4,
}

let nextEntryId = 0

export class Logger {
  static Level = LogLevel
  static Context = LogContext

  level: LogLevel
  context: string | undefined = undefined
  ambientMetadata: Record<string, unknown> = {}

  protected debugEnabled: boolean = true
  protected transports: Transport[] = []

  static create(context?: string, metadata: Record<string, unknown> = {}) {
    const logger = new Logger({
      level: process.env.EXPO_PUBLIC_LOG_LEVEL as LogLevel,
      context,
      contextFilter: process.env.EXPO_PUBLIC_LOG_DEBUG || '',
      metadata,
    })
    for (const transport of TRANSPORTS) {
      logger.addTransport(transport)
    }
    return logger
  }

  constructor({
    level,
    context,
    contextFilter,
    metadata: ambientMetadata = {},
  }: {
    level?: LogLevel
    context?: string
    contextFilter?: string
    metadata?: Record<string, unknown>
  } = {}) {
    this.context = context
    this.level = level || LogLevel.Info
    this.ambientMetadata = ambientMetadata

    const filter = contextFilter || ''
    if (filter) {
      this.level = LogLevel.Debug
      const regexes = filter
        .split(',')
        .map(f => new RegExp(f.replace(/[^\w:*-]/, '').replace(/\*/g, '.*')))
      this.debugEnabled = !context || regexes.some(reg => reg.test(context))
    }
  }

  debug(message: string, metadata: Metadata = {}) {
    this.transport({ level: LogLevel.Debug, message, metadata })
  }

  info(message: string, metadata: Metadata = {}) {
    this.transport({ level: LogLevel.Info, message, metadata })
  }

  log(message: string, metadata: Metadata = {}) {
    this.transport({ level: LogLevel.Log, message, metadata })
  }

  warn(message: string, metadata: Metadata = {}) {
    this.transport({ level: LogLevel.Warn, message, metadata })
  }

  error(error: Error | string, metadata: Metadata = {}) {
    this.transport({ level: LogLevel.Error, message: error, metadata })
  }

  addTransport(transport: Transport) {
    this.transports.push(transport)
    return () => {
      this.transports.splice(this.transports.indexOf(transport), 1)
    }
  }

  protected transport({
    level,
    message,
    metadata = {},
  }: {
    level: LogLevel
    message: string | Error
    metadata: Metadata
  }) {
    if (level === LogLevel.Debug && !this.debugEnabled) return
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.level]) return

    const timestamp = Date.now()
    const meta: Metadata = {
      __metadata__: this.ambientMetadata,
      ...metadata,
    }

    add({
      id: String(nextEntryId++),
      timestamp,
      level,
      context: this.context,
      message,
      metadata: meta,
    })

    const entry = { level, context: this.context, message, metadata: meta, timestamp }
    for (const transport of this.transports) {
      transport(entry)
    }
  }
}

export const logger = Logger.create(Logger.Context.Default)

export function createScopedLogger(scope: string): Logger {
  return Logger.create(scope)
}
