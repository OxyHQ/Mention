import { describe, it, expect } from 'vitest';
import { PostType } from '@mention/shared-types';
import { feedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { registerFilterModules } from '../mtn/feed/engine/filters';
import { registerSignalModules } from '../mtn/feed/engine/signals';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

registerFilterModules();
registerSignalModules();

function post(extra: Record<string, unknown> = {}): CandidatePost {
  return { _id: 'x', oxyUserId: 'a', createdAt: new Date(), ...extra };
}

describe('safety filter', () => {
  const safety = feedModuleRegistry.getFilter('safety')!;

  it('drops sensitive posts for a safe-for-work viewer', () => {
    const ctx: FeedEngineContext = { showSensitiveContent: false };
    expect(safety.keep!(post({ hashtags: ['nsfw'] }), ctx, {})).toBe(false);
    expect(safety.keep!(post({ postClassification: { sensitive: true } }), ctx, {})).toBe(false);
    expect(safety.keep!(post({ hashtags: ['tech'] }), ctx, {})).toBe(true);
  });

  it('drops sensitive posts even when showSensitiveContent is true', () => {
    const ctx: FeedEngineContext = { showSensitiveContent: true };
    expect(safety.keep!(post({ hashtags: ['nsfw'] }), ctx, {})).toBe(false);
    expect(safety.keep!(post({ postClassification: { sensitive: true } }), ctx, {})).toBe(false);
  });
});

describe('languagePreference filter', () => {
  const lang = feedModuleRegistry.getFilter('languagePreference')!;

  it('any-overlap match; passes posts with no declared language', () => {
    const ctx: FeedEngineContext = {};
    const params = { languages: ['es'] };
    expect(lang.keep!(post({ postClassification: { languages: ['en', 'es'] } }), ctx, params)).toBe(true);
    expect(lang.keep!(post({ postClassification: { languages: ['fr'] } }), ctx, params)).toBe(false);
    expect(lang.keep!(post({}), ctx, params)).toBe(true); // no language → pass through
  });
});

describe('noBoosts filter', () => {
  const noBoosts = feedModuleRegistry.getFilter('noBoosts')!;

  it('drops posts with boostOf set', () => {
    expect(noBoosts.keep!(post({ boostOf: 'abc' }), {}, {})).toBe(false);
    expect(noBoosts.keep!(post({}), {}, {})).toBe(true);
  });

  it('exposes a Mongo clause excluding boosts', () => {
    const clause = noBoosts.clause!({}, {});
    expect(clause).toBeDefined();
  });
});

describe('mediaOnly filter', () => {
  const mediaOnly = feedModuleRegistry.getFilter('mediaOnly')!;

  it('keeps only posts that carry media', () => {
    expect(mediaOnly.keep!(post({ type: PostType.IMAGE }), {}, {})).toBe(true);
    expect(mediaOnly.keep!(post({ content: { media: [{ type: 'image' }] } }), {}, {})).toBe(true);
    expect(mediaOnly.keep!(post({ type: PostType.TEXT }), {}, {})).toBe(false);
  });
});

describe('signal modules', () => {
  it('registers the ranking signals as weight-key metadata', () => {
    expect(feedModuleRegistry.getSignal('engagement')?.weightKey).toBe('engagement');
    expect(feedModuleRegistry.getSignal('authorAuthority')?.weightKey).toBe('authority');
    expect(feedModuleRegistry.getSignal('diversity')).toBeDefined();
  });
});
