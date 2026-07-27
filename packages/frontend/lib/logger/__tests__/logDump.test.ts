import { Logger } from '../index'
import { add, getEntries } from '../logDump'
import { LogLevel, type TransportEntry } from '../types'

describe('frontend logger safe boundary', () => {
  it('stores only a serializable, redacted logDump entry', () => {
    const cyclic: Record<string, unknown> = {
      body: 'private body',
      accessToken: 'private token',
      userId: '507f1f77bcf86cd799439011',
    }
    cyclic.self = cyclic

    add({
      id: 'safe-log-dump-test',
      timestamp: 123,
      level: LogLevel.Error,
      context: 'test',
      message: new Error('failed for person@example.com'),
      metadata: cyclic,
    })

    const entry = getEntries().find(({ id }) => id === 'safe-log-dump-test')
    expect(entry).toBeDefined()
    expect(typeof entry?.message).toBe('string')

    const serialized = JSON.stringify(entry)
    expect(serialized).not.toContain('private body')
    expect(serialized).not.toContain('private token')
    expect(serialized).not.toContain('507f1f77bcf86cd799439011')
    expect(serialized).not.toContain('person@example.com')
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).toContain('[Circular]')
  })

  it('sanitizes once before invoking transports', () => {
    const transported: TransportEntry[] = []
    const logger = new Logger({ level: LogLevel.Debug, context: 'SafeBoundary' })
    logger.addTransport((entry) => transported.push(entry))

    logger.info('request for @private-user', {
      query: { username: 'private-user' },
      authorization: 'Bearer private-token',
      status: 200,
      duration: 12,
      result: 'ok',
    })

    expect(transported).toHaveLength(1)
    expect(transported[0]).toMatchObject({
      message: 'request for [REDACTED]',
      metadata: {
        query: '[REDACTED]',
        authorization: '[REDACTED]',
        status: 200,
        duration: 12,
        result: 'ok',
      },
    })
    expect(() => JSON.stringify(transported[0])).not.toThrow()
  })
})
