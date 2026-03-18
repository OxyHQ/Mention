import { Platform } from 'react-native'

import { LogLevel, type Transport } from '../types'
import { prepareMetadata, formatTime } from '../util'

const ANSI_CODES: Record<string, [number, number]> = {
  blue: [36, 39],
  green: [32, 39],
  magenta: [35, 39],
  red: [31, 39],
  yellow: [33, 39],
}

function makeColorizer([x, y]: [number, number]) {
  const rgx = new RegExp(`\\x1b\\[${y}m`, 'g')
  const open = `\x1b[${x}m`
  const close = `\x1b[${y}m`

  return function (txt: string) {
    if (txt == null) return txt
    return (
      open +
      (~('' + txt).indexOf(close) ? txt.replace(rgx, close + open) : txt) +
      close
    )
  }
}

const nativeColorizers: Record<LogLevel, (txt: string) => string> = {
  [LogLevel.Debug]: makeColorizer(ANSI_CODES.magenta),
  [LogLevel.Info]: makeColorizer(ANSI_CODES.blue),
  [LogLevel.Log]: makeColorizer(ANSI_CODES.green),
  [LogLevel.Warn]: makeColorizer(ANSI_CODES.yellow),
  [LogLevel.Error]: makeColorizer(ANSI_CODES.red),
}

const WEB_CSS_COLORS: Record<LogLevel, string> = {
  [LogLevel.Debug]: 'magenta',
  [LogLevel.Info]: 'dodgerblue',
  [LogLevel.Log]: 'green',
  [LogLevel.Warn]: 'orange',
  [LogLevel.Error]: 'red',
}

export const consoleTransport: Transport = ({
  level,
  context,
  message,
  metadata,
  timestamp,
}) => {
  const hasMetadata = Object.keys(metadata).length > 0

  if (Platform.OS === 'web') {
    const cssColor = WEB_CSS_COLORS[level]
    const timestampStr = formatTime(timestamp)
    const contextStr = context ? ` (${context})` : ''
    const messageStr = message ? ` ${message.toString()}` : ''

    const styledPart = `%c${timestampStr}${contextStr}%c${messageStr}`
    const styles = [`color: ${cssColor}; font-weight: bold`, 'color: inherit']

    if (hasMetadata) {
      console.groupCollapsed(styledPart, ...styles)
      console.log(prepareMetadata(metadata))
      console.groupEnd()
    } else {
      console.log(styledPart, ...styles)
    }
    if (message instanceof Error) {
      console.error(message)
    }
  } else {
    const colorize = nativeColorizers[level]

    let msg = colorize(formatTime(timestamp))
    if (context) {
      msg += ` ${colorize(`(${context})`)}`
    }
    if (message) {
      msg += ` ${message.toString()}`
    }
    if (hasMetadata) {
      msg += ` ${JSON.stringify(prepareMetadata(metadata), null, 2)}`
    }
    console.log(msg)
    if (message instanceof Error) {
      console.error(message)
    }
  }
}
