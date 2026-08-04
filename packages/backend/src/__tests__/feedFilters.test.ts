import { describe, it, expect } from 'vitest';
import { PostType } from '@mention/shared-types';
import { feedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { filterModules, registerFilterModules } from '../mtn/feed/engine/filters';
import { registerSignalModules } from '../mtn/feed/engine/signals';
import type { FeedEngineContext, FilterModule } from '../mtn/feed/engine/types';
import { classification, feedCandidate } from './fixtures/feedCandidate';

registerFilterModules();
registerSignalModules();

/** The registered filter, or a failure naming the id — never an optional chain. */
function filter(id: string): Required<Pick<FilterModule, 'keep'>> & FilterModule {
  const module = feedModuleRegistry.getFilter(id);
  if (!module?.keep) throw new Error(`filter "${id}" is not registered with a keep predicate`);
  return { ...module, keep: module.keep };
}

const post = feedCandidate;

describe('safety filter', () => {
  const safety = filter('safety');

  it('drops sensitive posts for a safe-for-work viewer', () => {
    const ctx: FeedEngineContext = { showSensitiveContent: false };
    expect(safety.keep(post({ hashtags: ['nsfw'] }), ctx, {})).toBe(false);
    expect(safety.keep(post({ postClassification: classification({ sensitive: true }) }), ctx, {})).toBe(false);
    expect(safety.keep(post({ metadata: { isSensitive: true } }), ctx, {})).toBe(false);
    expect(safety.keep(post({ federation: { sensitive: true } }), ctx, {})).toBe(false);
    expect(safety.keep(post({ hashtags: ['tech'] }), ctx, {})).toBe(true);
  });

  it('drops sensitive posts even when showSensitiveContent is true', () => {
    const ctx: FeedEngineContext = { showSensitiveContent: true };
    expect(safety.keep(post({ hashtags: ['nsfw'] }), ctx, {})).toBe(false);
    expect(safety.keep(post({ postClassification: classification({ sensitive: true }) }), ctx, {})).toBe(false);
  });
});

describe('languagePreference filter', () => {
  const lang = filter('languagePreference');

  it('any-overlap match; passes posts with no declared language', () => {
    const ctx: FeedEngineContext = {};
    const params = { languages: ['es'] };
    expect(lang.keep(post({ postClassification: classification({ languages: ['en', 'es'] }) }), ctx, params)).toBe(true);
    expect(lang.keep(post({ postClassification: classification({ languages: ['fr'] }) }), ctx, params)).toBe(false);
    expect(lang.keep(post(), ctx, params)).toBe(true); // no language → pass through
  });
});

describe('noBoosts filter', () => {
  const noBoosts = filter('noBoosts');

  it('drops posts with boostOf set and keeps every original', () => {
    expect(noBoosts.keep(post({ boostOf: 'abc' }), {}, {})).toBe(false);
    // `boostOf` is a NULLABLE column now, not an absent key: null is what a
    // non-boost actually carries, and it must not read as "boosted".
    expect(noBoosts.keep(post({ boostOf: null }), {}, {})).toBe(true);
    expect(noBoosts.keep(post(), {}, {})).toBe(true);
  });
});

describe('noReplies / onlyReplies filters read the STORED discriminator', () => {
  const noReplies = filter('noReplies');
  const onlyReplies = filter('onlyReplies');

  it('classifies on `isReply`, never on the parent link', () => {
    // `ON DELETE SET NULL` clears `parent_post_id`, so an orphaned reply has a
    // null parent and is still a reply. Deriving from the link here is what put
    // orphans back into the root feeds.
    const orphanedReply = post({ isReply: true, parentPostId: null });
    expect(noReplies.keep(orphanedReply, {}, {})).toBe(false);
    expect(onlyReplies.keep(orphanedReply, {}, {})).toBe(true);

    const root = post({ isReply: false, parentPostId: null });
    expect(noReplies.keep(root, {}, {})).toBe(true);
    expect(onlyReplies.keep(root, {}, {})).toBe(false);
  });

  it('treats a federated reply with no local parent as a reply', () => {
    const federatedReply = post({
      isReply: true,
      parentPostId: null,
      federation: { inReplyTo: 'https://remote.example/notes/1' },
    });
    expect(noReplies.keep(federatedReply, {}, {})).toBe(false);
    expect(onlyReplies.keep(federatedReply, {}, {})).toBe(true);
  });
});

describe('mediaOnly filter', () => {
  const mediaOnly = filter('mediaOnly');

  it('keeps only posts that carry media', () => {
    expect(mediaOnly.keep(post({ type: PostType.IMAGE }), {}, {})).toBe(true);
    expect(
      mediaOnly.keep(
        post({ content: { variants: [{ source: 'author', text: '' }], media: [{ id: 'm1', type: 'image' }] } }),
        {},
        {},
      ),
    ).toBe(true);
    expect(mediaOnly.keep(post({ type: PostType.TEXT }), {}, {})).toBe(false);
  });
});

describe('filters apply through keep() only', () => {
  it('every filter in the catalog is a keep predicate, apart from the declared marker', () => {
    // Filters used to also carry a Mongo `clause()` that nothing ever evaluated
    // — the engine applies filters exclusively through `keep()` on the merged
    // pool. `dedupe` is the ONE module with no predicate, and it says so: the
    // engine merge does that work, the module only declares the intent.
    const withoutKeep = filterModules.filter((module) => !module.keep).map((module) => module.id);
    expect(withoutKeep).toEqual(['dedupe']);
    expect(filterModules.length).toBeGreaterThan(40);
  });
});

describe('signal modules', () => {
  it('registers the ranking signals as weight-key metadata', () => {
    expect(feedModuleRegistry.getSignal('engagement')?.weightKey).toBe('engagement');
    expect(feedModuleRegistry.getSignal('authorAuthority')?.weightKey).toBe('authority');
    expect(feedModuleRegistry.getSignal('diversity')).toBeDefined();
  });
});
