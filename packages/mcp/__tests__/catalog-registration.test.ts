/**
 * The MCP registers the catalogue it serves and binds its internal receiver to
 * the registration Oxy returns; a failure must name its own cause. The Oxy SDK
 * rejects with a plain object rather than an `Error` — so a real failure (twice,
 * in production) once reached the log as the literal text `[object Object]`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { appCapabilityCatalogSchema, canonicalCapabilityJson } from '@oxy.so/contracts';

import { describeRegistrationFailure, registerMentionCatalog } from '../lib/catalog-registration';
import { MENTION_CAPABILITY_CATALOG } from '../lib/mention-catalog';

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
    expect(describeRegistrationFailure({ message: 'Forbidden', statusCode: 403 })).toBe(
      'Forbidden status=403',
    );
  });

  test('keeps an Error message as-is', () => {
    expect(describeRegistrationFailure(new Error('OXY_SERVICE_API_KEY is required'))).toBe(
      'OXY_SERVICE_API_KEY is required',
    );
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

describe('registerMentionCatalog', () => {
  const oxy = (fetch: typeof globalThis.fetch) => ({
    createServiceClient: () => ({ fetch, dispose() {} }),
  });

  test('binds to the registration Oxy returns for exactly this catalogue', async () => {
    const digest = createHash('sha256')
      .update(canonicalCapabilityJson(appCapabilityCatalogSchema.parse(MENTION_CAPABILITY_CATALOG)))
      .digest('hex');
    let sent: { url: string; authorization: string | null; body: { catalog: unknown } } | null =
      null;
    const binding = await registerMentionCatalog({
      oxyApiUrl: 'https://api.oxy.test',
      oxy: oxy((async (url: string, init: RequestInit) => {
        sent = {
          url,
          authorization: new Headers(init.headers).get('authorization'),
          body: JSON.parse(String(init.body)),
        };
        return Response.json({
          registration: {
            id: '01a0ed95-305f-7605-8d8b-6c5578e8b60f',
            version: MENTION_CAPABILITY_CATALOG.version,
            digest,
          },
        });
      }) as typeof fetch),
    });
    expect(sent!.url).toBe('https://api.oxy.test/capabilities/catalogs/register');
    expect(sent!.authorization).toBeNull();
    expect(sent!.body.catalog).toEqual(
      appCapabilityCatalogSchema.parse(MENTION_CAPABILITY_CATALOG),
    );
    expect(binding).toEqual({
      registrationId: '01a0ed95-305f-7605-8d8b-6c5578e8b60f',
      version: MENTION_CAPABILITY_CATALOG.version,
      digest,
    });
  });

  test('names the status and body Oxy refused with', async () => {
    const refused = registerMentionCatalog({
      oxyApiUrl: 'https://api.oxy.test',
      oxy: oxy(
        (async () => new Response('{"error":"operation_denied"}', { status: 403 })) as typeof fetch,
      ),
    });
    await expect(refused).rejects.toMatchObject({ status: 403 });
  });
});
