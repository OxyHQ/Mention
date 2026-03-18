export enum LogContext {
  Default = 'logger',
}

export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Log = 'log',
  Warn = 'warn',
  Error = 'error',
}

export type Transport = (
  level: LogLevel,
  context: string | undefined,
  message: string | Error,
  metadata: Metadata,
  timestamp: number,
) => void

export type Metadata = {
  __context__?: undefined
  __metadata__?: Record<string, unknown>
  type?:
    | 'default'
    | 'debug'
    | 'error'
    | 'navigation'
    | 'http'
    | 'info'
    | 'query'
    | 'transaction'
    | 'ui'
    | 'user'
  tags?: {
    [key: string]: number | string | boolean | null | undefined
  }
  [key: string]: Serializable | Error | unknown
}

export type Serializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Serializable[]
  | {
      [key: string]: Serializable
    }
