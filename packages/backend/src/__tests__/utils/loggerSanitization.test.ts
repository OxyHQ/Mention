import { describe, expect, it, vi } from 'vitest';

vi.unmock('../../utils/logger');

import { sanitizeLogValue } from '../../utils/logger';

const REDACTED = '[REDACTED]';

describe('sanitizeLogValue', () => {
  it('preserves bounded operational fields while recursively redacting private metadata', () => {
    const requestId = '550e8400-e29b-41d4-a716-446655440000';
    const sanitized = sanitizeLogValue({
      requestId,
      route: '/posts/:id',
      durationMs: 42,
      result: 'ok',
      statusCode: 200,
      nested: {
        body: { text: 'private post body' },
        query: { search: 'private query' },
        params: { postId: '65fdc8c8c8c8c8c8c8c8c8c8' },
        content: 'private content',
        userId: '65fdc8c8c8c8c8c8c8c8c8c8',
        postIds: ['65fdc8c8c8c8c8c8c8c8c8c9'],
        actorUri: 'https://social.example/users/alice',
        handle: '@alice@social.example',
        username: 'alice',
        email: 'alice@example.com',
        ip: '203.0.113.10',
        ipAddress: '2001:db8::1',
        password: 'correct-horse-battery-staple',
        token: 'secret-token',
        url: 'https://alice:password@example.com/private',
      },
    }) as Record<string, unknown>;

    expect(sanitized).toMatchObject({
      requestId,
      route: '/posts/:id',
      durationMs: 42,
      result: 'ok',
      statusCode: 200,
    });
    expect(sanitized.nested).toEqual({
      body: REDACTED,
      query: REDACTED,
      params: REDACTED,
      content: REDACTED,
      userId: REDACTED,
      postIds: REDACTED,
      actorUri: REDACTED,
      handle: REDACTED,
      username: REDACTED,
      email: REDACTED,
      ip: REDACTED,
      ipAddress: REDACTED,
      password: REDACTED,
      token: REDACTED,
      url: REDACTED,
    });
  });

  it.each([
    ['Mongo ObjectId', 'post 65fdc8c8c8c8c8c8c8c8c8c8 failed'],
    ['UUID', 'subject 550e8400-e29b-41d4-a716-446655440000 failed'],
    ['Oxy hyphen id', 'subject oxy-user-123 failed'],
    ['Oxy underscore id', 'subject oxy_user_123 failed'],
    ['IPv4', 'peer 203.0.113.10 failed'],
    ['IPv6', 'peer 2001:db8::1 failed'],
    ['email', 'account alice@example.com failed'],
    ['fediverse handle', 'account @alice@social.example failed'],
    ['local handle', 'account @alice failed'],
    ['Bearer credential', 'Bearer abc.def.ghi'],
    ['credential URL', 'https://alice:password@example.com/private?token=abc'],
    ['MongoDB URI', 'mongodb://alice:password@mongo.internal/mention'],
    ['Redis URI', 'redis://:password@redis.internal:6379/0'],
  ])('redacts a bare %s embedded in a string', (_kind, value) => {
    const sanitized = String(sanitizeLogValue(value));

    expect(sanitized).toContain(REDACTED);
    expect(sanitized).not.toContain('alice');
    expect(sanitized).not.toContain('password');
    expect(sanitized).not.toContain('65fdc8c8c8c8c8c8c8c8c8c8');
    expect(sanitized).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(sanitized).not.toContain('oxy-user-123');
    expect(sanitized).not.toContain('oxy_user_123');
    expect(sanitized).not.toContain('203.0.113.10');
    expect(sanitized).not.toContain('2001:db8::1');
  });

  it('keeps a non-sensitive URL host but drops its path and query', () => {
    expect(
      sanitizeLogValue('upstream https://public.example/users/alice?token=secret failed'),
    ).toBe('upstream https://public.example/[REDACTED] failed');
  });

  it('sanitizes Error fields and nested causes without exposing connection details', () => {
    const cause = new Error(
      'mongodb://db-user:db-password@mongo.internal/mention',
    );
    const error = Object.assign(
      new Error(
        'Post 65fdc8c8c8c8c8c8c8c8c8c8 for oxy_user_123 failed at 2001:db8::1',
        { cause },
      ),
      { code: '550e8400-e29b-41d4-a716-446655440000' },
    );

    const sanitized = sanitizeLogValue(error) as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toMatchObject({
      name: 'Error',
      code: REDACTED,
    });
    expect(serialized).toContain(REDACTED);
    expect(serialized).not.toMatch(
      /65fdc8c8c8c8c8c8c8c8c8c8|oxy_user_123|2001:db8::1|mongo\.internal|db-password|mongodb:\/\//,
    );
  });

  it('does not execute accessors and handles invalid dates safely', () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {
      when: new Date(Number.NaN),
    };
    Object.defineProperty(input, 'computed', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });

    expect(sanitizeLogValue(input)).toEqual({
      when: '[Invalid Date]',
      computed: '[Accessor]',
    });
    expect(getterCalls).toBe(0);
  });

  it('bounds depth, breadth, arrays and strings while tolerating cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 8; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }

    const wide = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [`field${index}`, index]),
    );
    const sanitized = sanitizeLogValue({
      cyclic,
      deep,
      wide,
      array: Array.from({ length: 25 }, (_, index) => index),
      long: 'x'.repeat(2_500),
      callable: () => 'private',
    }) as Record<string, unknown>;

    expect((sanitized.cyclic as Record<string, unknown>).self).toBe('[Circular]');
    expect(JSON.stringify(sanitized.deep)).toContain('[Truncated]');
    expect(Object.keys(sanitized.wide as Record<string, unknown>)).toHaveLength(51);
    expect((sanitized.wide as Record<string, unknown>).__truncated__).toBe(true);
    expect(sanitized.array).toHaveLength(21);
    expect((sanitized.array as unknown[]).at(-1)).toBe('[Truncated]');
    expect(String(sanitized.long)).toContain('[Truncated]');
    expect(sanitized.callable).toBe('[Function]');
  });

  it('fails closed for objects that cannot be inspected', () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('hostile proxy');
      },
    });

    expect(sanitizeLogValue(hostile)).toBe('[Unserializable]');
  });
});
