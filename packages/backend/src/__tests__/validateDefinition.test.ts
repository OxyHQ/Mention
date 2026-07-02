import { beforeAll, describe, it, expect } from 'vitest';

/**
 * Task 3 — validateDefinition guards every user-authored custom-feed definition:
 * registered + user-composable modules only, param caps, a valid mode, at least
 * one enabled source, and rejection of viewer-relative (non-composable) sources.
 */

import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerAllModules } from '../mtn/feed/engine';
import { validateDefinition } from '../mtn/feed/definitions/validateDefinition';

const registry = new FeedModuleRegistry();

beforeAll(() => {
  registerAllModules(registry);
});

function validate(input: unknown) {
  return validateDefinition(input, { registry });
}

describe('validateDefinition', () => {
  it('accepts a valid ranked definition and whitelists ref fields', () => {
    const result = validate({
      mode: 'ranked',
      sources: [
        { module: 'accounts', enabled: true, params: { authorIds: ['a1', 'a2'] }, junk: 'drop-me' },
        { module: 'trending', enabled: true },
      ],
      signals: [{ module: 'engagement', enabled: true, weight: 2 }],
      filters: [{ module: 'noReplies', enabled: true }],
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.definition.mode).toBe('ranked');
    // Only the whitelisted ref keys survive.
    expect(Object.keys(result.definition.sources[0]).sort()).toEqual(['enabled', 'module', 'params']);
    expect(result.definition.sources[0]).not.toHaveProperty('junk');
    expect(result.definition.signals[0]).toMatchObject({ module: 'engagement', enabled: true, weight: 2 });
  });

  it('accepts a chronological keyword feed', () => {
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'keywords', enabled: true, params: { hashtags: ['comics'] } }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown module', () => {
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'not_a_module', enabled: true }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-composable source (viewer-relative)', () => {
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'following', enabled: true }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a viewer-relative source with a foreign id (server forces owner)', () => {
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'authored', enabled: true, params: { authorId: 'someone-else' } }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-composable filter', () => {
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'keywords', enabled: true, params: { keywords: ['x'] } }],
      signals: [],
      filters: [{ module: 'safety', enabled: true }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an oversized accounts list (> 200)', () => {
    const authorIds = Array.from({ length: 201 }, (_, i) => `a${i}`);
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'accounts', enabled: true, params: { authorIds } }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an oversized keywords list (> 50)', () => {
    const keywords = Array.from({ length: 51 }, (_, i) => `k${i}`);
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'keywords', enabled: true, params: { keywords } }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a definition with no enabled source', () => {
    const result = validate({
      mode: 'chronological',
      sources: [{ module: 'keywords', enabled: false, params: { keywords: ['x'] } }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an invalid mode', () => {
    const result = validate({
      mode: 'nonsense',
      sources: [{ module: 'keywords', enabled: true, params: { keywords: ['x'] } }],
      signals: [],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a non-object input', () => {
    expect(validate(null).valid).toBe(false);
    expect(validate('nope').valid).toBe(false);
    expect(validate({ mode: 'ranked' }).valid).toBe(false);
  });

  it('rejects a signal that is not a registered signal module', () => {
    const result = validate({
      mode: 'ranked',
      sources: [{ module: 'keywords', enabled: true, params: { keywords: ['x'] } }],
      signals: [{ module: 'accounts', enabled: true }],
      filters: [],
    });
    expect(result.valid).toBe(false);
  });
});
