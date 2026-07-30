import {
  createLogger,
  getLoggerConfig,
  resetLoggerConfig,
  type LogEntry,
} from '@oxyhq/core/logger'

import { appLogSink, configureAppLogging } from '..'

/**
 * The two behaviours the app-local logger had that the bare SDK logger does
 * not: `debug` stays off unless explicitly asked for, and nothing reaches a
 * transport unscrubbed.
 */
describe('app logging configuration', () => {
  afterEach(() => {
    resetLoggerConfig()
    jest.restoreAllMocks()
  })

  it('does not emit debug at the app-configured level', () => {
    configureAppLogging()
    expect(getLoggerConfig().level).toBe('info')

    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const feed = createLogger('feed')

    feed.debug('candidate pool', { count: 20 })
    expect(log).not.toHaveBeenCalled()

    // …and the same logger at a passing level does reach the console, so the
    // assertion above cannot pass just because nothing is wired up.
    feed.info('candidate pool ready', { count: 20 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('emits warn and error, scrubbed, through the console', () => {
    configureAppLogging()
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})

    createLogger('feed').error(
      'failed for person@example.com',
      new Error('GET https://api.example/feed failed'),
      { postId: '507f1f77bcf86cd799439011', status: 500 },
    )

    expect(error).toHaveBeenCalledTimes(1)
    const [line, ...extras] = error.mock.calls[0]
    expect(String(line)).toContain('[REDACTED]')
    expect(String(line)).not.toContain('person@example.com')
    expect(extras).toEqual([
      { postId: '[REDACTED]', status: 500 },
      expect.objectContaining({ message: 'GET [REDACTED] failed' }),
    ])
  })

  it('scrubs entries handed straight to the sink', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const entry: LogEntry = {
      level: 'info',
      message: 'linked @private-user',
      args: [],
      timestamp: '2026-07-31T00:00:00.000Z',
    }

    appLogSink(entry)

    expect(String(log.mock.calls[0][0])).toContain('linked [REDACTED]')
  })
})
