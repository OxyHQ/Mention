import type { LogEntry } from '@oxyhq/core/logger'

import {
  CIRCULAR,
  MAX_DEPTH_REACHED,
  REDACTED,
  TRUNCATED,
  sanitizeLogContext,
  sanitizeLogEntry,
  sanitizeLogMessage,
} from '../sanitize'

describe('frontend logger sanitizer', () => {
  it('redacts private fields while preserving bounded operational metadata', () => {
    const sanitized = sanitizeLogContext({
      body: { text: 'private post' },
      requestQuery: { search: 'private query' },
      params: { postId: '507f1f77bcf86cd799439011' },
      content: 'private content',
      text: 'private text',
      accessToken: 'secret-token',
      authorization: 'Bearer secret-token',
      cookies: 'session=secret',
      clientSecret: 'client-secret',
      password: 'password',
      email: 'person@example.com',
      username: 'private-user',
      handle: '@private-user',
      postId: '507f1f77bcf86cd799439011',
      participantIds: ['one', 'two'],
      actorUri: 'https://social.example/users/private',
      avatarUrl: 'https://cdn.example/private.jpg',
      ipAddress: '203.0.113.42',
      count: 4,
      status: 201,
      statusCode: 201,
      type: 'http',
      kind: 'feed',
      duration: 17,
      durationMs: 17,
      result: {
        status: 'ok',
        userId: '507f1f77bcf86cd799439011',
      },
    })

    for (const key of [
      'body',
      'requestQuery',
      'params',
      'content',
      'text',
      'accessToken',
      'authorization',
      'cookies',
      'clientSecret',
      'password',
      'email',
      'username',
      'handle',
      'postId',
      'participantIds',
      'actorUri',
      'avatarUrl',
      'ipAddress',
    ]) {
      expect(sanitized[key]).toBe(REDACTED)
    }

    expect(sanitized).toMatchObject({
      count: 4,
      status: 201,
      statusCode: 201,
      type: 'http',
      kind: 'feed',
      duration: 17,
      durationMs: 17,
      result: {
        status: 'ok',
        userId: REDACTED,
      },
    })
  })

  it('serializes errors and hostile object graphs into bounded JSON data', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    let getterRead = false
    const withGetter = Object.defineProperty({}, 'computed', {
      enumerable: true,
      get() {
        getterRead = true
        return 'must-not-run'
      },
    })

    const deep = { value: { value: { value: { value: { value: 'hidden' } } } } }
    const manyKeys = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`safe${index}`, index]),
    )
    const error = new Error(
      'request for person@example.com at https://private.example failed from 203.0.113.9',
    )

    const sanitized = sanitizeLogContext({
      error,
      cyclic,
      withGetter,
      deep,
      manyKeys,
      values: Array.from({ length: 30 }, (_, index) => index),
      long: 'x'.repeat(1_100),
    })

    expect(getterRead).toBe(false)
    expect(sanitized.error).toMatchObject({
      name: 'Error',
      message: `request for ${REDACTED} at ${REDACTED} failed from ${REDACTED}`,
    })
    expect(sanitized.cyclic).toEqual({ self: CIRCULAR })
    expect(sanitized.withGetter).toEqual({ computed: '[Accessor]' })
    expect(JSON.stringify(sanitized.deep)).toContain(MAX_DEPTH_REACHED)
    expect(sanitized.manyKeys).toMatchObject({ __truncated_keys__: 5 })
    expect(sanitized.values).toHaveLength(26)
    expect((sanitized.values as unknown[]).at(-1)).toBe(TRUNCATED)
    expect(String(sanitized.long)).toContain(TRUNCATED)
    expect(() => JSON.stringify(sanitized)).not.toThrow()
  })

  it('scrubs identifiers and credentials interpolated into messages', () => {
    const message = sanitizeLogMessage(
      'viewer 507f1f77bcf86cd799439011 @private-user person@example.com ' +
        'Bearer abc.def.ghi https://private.example 203.0.113.8',
    )

    expect(message).not.toContain('507f1f77bcf86cd799439011')
    expect(message).not.toContain('@private-user')
    expect(message).not.toContain('person@example.com')
    expect(message).not.toContain('abc.def.ghi')
    expect(message).not.toContain('private.example')
    expect(message).not.toContain('203.0.113.8')
    expect(message.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it('scrubs every slot of an SDK log entry, including the error and args', () => {
    const entry: LogEntry = {
      level: 'error',
      message: 'upload failed for person@example.com',
      namespace: 'mediaUpload',
      context: { postId: '507f1f77bcf86cd799439011', status: 500 },
      error: new Error('POST https://cdn.example/upload rejected'),
      args: ['retrying for @private-user', { authorization: 'Bearer abc.def' }],
      timestamp: '2026-07-31T00:00:00.000Z',
    }

    const sanitized = sanitizeLogEntry(entry)

    expect(sanitized.message).toBe(`upload failed for ${REDACTED}`)
    expect(sanitized.namespace).toBe('mediaUpload')
    expect(sanitized.context).toEqual({ postId: REDACTED, status: 500 })
    expect(sanitized.error).toMatchObject({
      name: 'Error',
      message: `POST ${REDACTED} rejected`,
    })
    expect(sanitized.args[0]).toBe(`retrying for ${REDACTED}`)
    expect(sanitized.args[1]).toEqual({ authorization: REDACTED })
    expect(sanitized.level).toBe('error')
    expect(sanitized.timestamp).toBe(entry.timestamp)
  })

  it('leaves an entry with no context, error or args intact', () => {
    const sanitized = sanitizeLogEntry({
      level: 'info',
      message: 'feed loaded',
      args: [],
      timestamp: '2026-07-31T00:00:00.000Z',
    })

    expect(sanitized).toEqual({
      level: 'info',
      message: 'feed loaded',
      namespace: undefined,
      context: undefined,
      error: undefined,
      args: [],
      timestamp: '2026-07-31T00:00:00.000Z',
    })
  })
})
