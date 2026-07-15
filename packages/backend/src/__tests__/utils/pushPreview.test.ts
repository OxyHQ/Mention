import { describe, expect, it, vi } from 'vitest';

/**
 * The push-notification preview: a ONE-LINE label built from a post body, which
 * on a federated post carries the remote markup's newlines and indentation. It
 * used to collapse that whitespace with its own inline regex — the fifth copy of
 * the canonical collapser in the ecosystem. It now delegates to
 * `normalizeInlineText`, keeping only its own product rule: the length budget.
 *
 * `push.ts` pulls in firebase-admin and the Mongo models at import time, so both
 * are stubbed — `buildPreview` itself is pure.
 */
vi.mock('firebase-admin', () => ({ default: { apps: [], initializeApp: vi.fn(), credential: { cert: vi.fn() } } }));
vi.mock('../../models/PushToken', () => ({ default: { find: vi.fn() } }));
vi.mock('../../models/Post', () => ({ default: { findById: vi.fn() } }));
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));

import { buildPreview } from '../../utils/push';

describe('buildPreview', () => {
  it('collapses the newlines and indentation of a federated post body', () => {
    expect(buildPreview('  Hola\n\n      mundo  ')).toBe('Hola mundo');
  });

  it('collapses tabs, CRLF and non-breaking spaces', () => {
    expect(buildPreview('uno\r\n\tdos  tres')).toBe('uno dos tres');
  });

  it('truncates to the limit with an ellipsis — the length budget stays a push rule', () => {
    expect(buildPreview('a'.repeat(250), 200)).toBe(`${'a'.repeat(200)}…`);
    expect(buildPreview('a'.repeat(200), 200)).toBe('a'.repeat(200));
  });

  it('measures the limit AFTER collapsing, not against the raw text', () => {
    // 10 words padded with runs of whitespace: raw length is far over the limit,
    // the collapsed preview is not, so nothing is truncated.
    const padded = Array.from({ length: 10 }, () => 'hola').join('\n\n      ');
    expect(buildPreview(padded, 60)).toBe(Array.from({ length: 10 }, () => 'hola').join(' '));
  });

  it('returns an empty string for empty or whitespace-only text', () => {
    expect(buildPreview('')).toBe('');
    expect(buildPreview('   \n\t  ')).toBe('');
  });
});
