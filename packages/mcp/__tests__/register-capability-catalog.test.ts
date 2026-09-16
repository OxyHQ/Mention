/**
 * The post-deploy reconciliation task must be able to name its own failure.
 *
 * It runs after the MCP service rolls out and a non-zero exit rolls the service
 * BACK, so its stderr is the only evidence of why production did not move. It
 * printed `String(error)`, and the Oxy SDK rejects with a plain object rather
 * than an `Error` — so a real failure (twice, in production) reached the deploy
 * log as the literal text `[object Object]`.
 */
import { describe, expect, test } from 'bun:test';

import { describeRegistrationFailure } from '../register-capability-catalog';

describe('describeRegistrationFailure', () => {
  test('names the status and code the Oxy SDK rejects with', () => {
    const described = describeRegistrationFailure({
      message: 'HTTP 429: Too Many Requests',
      code: 'INTERNAL_ERROR',
      status: 429,
    });

    expect(described).toBe('HTTP 429: Too Many Requests status=429 code=INTERNAL_ERROR');
  });

  test('reads statusCode when that is the field carried', () => {
    expect(describeRegistrationFailure({ message: 'Forbidden', statusCode: 403 }))
      .toBe('Forbidden status=403');
  });

  test('keeps an Error message as-is', () => {
    expect(describeRegistrationFailure(new Error('OXY_SERVICE_API_KEY is required')))
      .toBe('OXY_SERVICE_API_KEY is required');
  });

  test('never answers [object Object] for an unanticipated shape', () => {
    const described = describeRegistrationFailure({ unexpected: { nested: true } });

    expect(described).not.toContain('[object Object]');
    expect(described).toBe('{"unexpected":{"nested":true}}');
  });

  test('bounds a large payload so it cannot flood the deploy log', () => {
    const described = describeRegistrationFailure({ blob: 'x'.repeat(5_000) });

    expect(described.length).toBeLessThanOrEqual(500);
  });

  test('survives a value that cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(describeRegistrationFailure(circular)).toBe('unknown failure (unserializable)');
  });

  test('still describes a primitive rejection', () => {
    expect(describeRegistrationFailure('boom')).toBe('boom');
    expect(describeRegistrationFailure(undefined)).toBe('undefined');
  });
});
