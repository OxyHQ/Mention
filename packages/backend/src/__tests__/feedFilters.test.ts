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

describe('noContentWarning filter', () => {
  const cw = filter('noContentWarning');
  const GATE = { viewerGateTuning: true } as const;
  const warned = (authorId = 'author-1') =>
    post({ oxyUserId: authorId, federation: { spoilerText: 'spoilers' } });

  it('drops a content-warned post from an author the viewer does not follow', () => {
    const ctx: FeedEngineContext = { followingIdSet: new Set(['someone-else']) };
    expect(cw.keep(warned(), ctx, GATE)).toBe(false);
  });

  it('keeps it when the viewer follows the author — they chose this account', () => {
    const ctx: FeedEngineContext = { followingIdSet: new Set(['author-1']) };
    expect(cw.keep(warned('author-1'), ctx, GATE)).toBe(true);
  });

  it('is a NO-OP on a Following feed, by construction', () => {
    // Every author on that feed is followed, so the exemption fires for all of
    // them. This is the whole reason the exemption lives in the predicate rather
    // than in which definitions list the module: no present or future definition
    // has to remember not to opt in.
    const authors = ['a', 'b', 'c'];
    const ctx: FeedEngineContext = { followingIdSet: new Set(authors) };
    expect(authors.every((id) => cw.keep(warned(id), ctx, GATE))).toBe(true);
  });

  it('applies in full to an anonymous reader, who follows nobody', () => {
    expect(cw.keep(warned(), {}, GATE)).toBe(false);
  });

  it('ignores a blank or whitespace-only spoiler — that is not a warning', () => {
    const ctx: FeedEngineContext = {};
    expect(cw.keep(post({ federation: { spoilerText: '' } }), ctx, GATE)).toBe(true);
    expect(cw.keep(post({ federation: { spoilerText: '   ' } }), ctx, GATE)).toBe(true);
    expect(cw.keep(post({ federation: {} }), ctx, GATE)).toBe(true);
  });

  it('leaves a post with no warning alone whoever wrote it', () => {
    expect(cw.keep(post({ oxyUserId: 'stranger' }), {}, GATE)).toBe(true);
  });

  it('honors the reader turning it off', () => {
    const ctx: FeedEngineContext = { feedTuning: { forYou: { noContentWarning: { enabled: false } } } };
    expect(cw.keep(warned(), ctx, GATE)).toBe(true);
  });

  it('does NOT read the reader\u2019s setting without the marker — a custom feed is static', () => {
    const ctx: FeedEngineContext = { feedTuning: { forYou: { noContentWarning: { enabled: false } } } };
    expect(cw.keep(warned(), ctx, {})).toBe(false);
  });
});

/**
 * THE AUTHOR FILTERS, which for a long time declared an intent they could not
 * carry out. What makes them real is `needsAuthor` plus the engine's batch; what
 * keeps them safe is that an unknown author is never a failing answer.
 */
describe('author filters read the resolved account', () => {
  // `username` is always set: an EMPTY one is what marks the degraded placeholder,
  // so a fixture that forgets it silently tests the unresolved path instead of the
  // one it names.
  const summaries = (entries: Record<string, Record<string, unknown>>): FeedEngineContext => ({
    authorSummaries: new Map(
      Object.entries(entries).map(([id, summary]) => [
        id,
        { ...summary, user: { id, name: {}, username: id, ...(summary.user as object ?? {}) } },
      ]),
    ),
  } as FeedEngineContext);
  const p = (authorId = 'a1') => post({ oxyUserId: authorId });

  it('every one of them declares needsAuthor, or the batch never runs for it', () => {
    for (const id of ['verifiedOnly', 'verifiedFollowsOnly', 'minFollowers', 'minAccountAge', 'authorHasAvatar']) {
      expect(filter(id).needsAuthor).toBe(true);
    }
  });

  it('verifiedOnly enforces on a resolved account and abstains on an unknown one', () => {
    expect(filter('verifiedOnly').keep(p(), summaries({ a1: { user: { verified: true } } }), {})).toBe(true);
    expect(filter('verifiedOnly').keep(p(), summaries({ a1: { user: { verified: false } } }), {})).toBe(false);
    expect(filter('verifiedOnly').keep(p(), {}, {})).toBe(true);
    expect(filter('verifiedOnly').keep(p(), summaries({}), {})).toBe(true);
  });

  it('minFollowers enforces a real floor, and abstains when the count is unknown', () => {
    const params = { minFollowers: 100 };
    expect(filter('minFollowers').keep(p(), summaries({ a1: { followerCount: 500 } }), params)).toBe(true);
    expect(filter('minFollowers').keep(p(), summaries({ a1: { followerCount: 5 } }), params)).toBe(false);
    expect(filter('minFollowers').keep(p(), summaries({ a1: {} }), params)).toBe(true);
    expect(filter('minFollowers').keep(p(), {}, params)).toBe(true);
  });

  it('minAccountAge reads the creation date Oxy always sent', () => {
    const params = { minAgeDays: 30 };
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    expect(filter('minAccountAge').keep(p(), summaries({ a1: { accountCreatedAt: daysAgo(90) } }), params)).toBe(true);
    expect(filter('minAccountAge').keep(p(), summaries({ a1: { accountCreatedAt: daysAgo(2) } }), params)).toBe(false);
    expect(filter('minAccountAge').keep(p(), summaries({ a1: { accountCreatedAt: 'not a date' } }), params)).toBe(true);
    expect(filter('minAccountAge').keep(p(), {}, params)).toBe(true);
  });

  it('the degraded placeholder is not read as an account with nothing filled in', () => {
    // `degradedActorSummary` is blank everywhere, so read naively it says
    // "unverified, no followers, no picture" about an account nobody resolved.
    const degraded = { authorSummaries: new Map([['a1', { user: { id: 'a1', username: '', name: {}, avatar: null } }]]) } as FeedEngineContext;
    expect(filter('verifiedOnly').keep(p(), degraded, {})).toBe(true);
    expect(filter('minFollowers').keep(p(), degraded, { minFollowers: 100 })).toBe(true);
    expect(filter('authorHasAvatar').keep(p(), degraded, { applyToFederated: true })).toBe(true);
  });
});

describe('authorHasAvatar filter', () => {
  const avatar = (value: unknown, extra: Record<string, unknown> = {}): FeedEngineContext => ({
    authorSummaries: new Map([['a1', { user: { id: 'a1', username: 'a1', name: {}, avatar: value, ...extra } }]]),
  } as FeedEngineContext);
  const p = () => post({ oxyUserId: 'a1' });
  const ALL = { applyToFederated: true };

  it('treats null, undefined, empty and whitespace alike as no picture', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(filter('authorHasAvatar').keep(p(), avatar(value), ALL)).toBe(false);
    }
  });

  it('accepts any non-blank string — a file id or an absolute URL', () => {
    expect(filter('authorHasAvatar').keep(p(), avatar('file-abc'), ALL)).toBe(true);
    expect(filter('authorHasAvatar').keep(p(), avatar('https://example.test/a.png'), ALL)).toBe(true);
  });

  it('EXEMPTS federated accounts unless asked not to', () => {
    // Their picture reaches Mention through a background download that can be
    // skipped or fail, so judging them on it judges our own plumbing.
    const fedi = avatar(null, { isFederated: true });
    expect(filter('authorHasAvatar').keep(p(), fedi, {})).toBe(true);
    expect(filter('authorHasAvatar').keep(p(), fedi, ALL)).toBe(false);
  });

  it('abstains on an unknown author', () => {
    expect(filter('authorHasAvatar').keep(p(), {}, ALL)).toBe(true);
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
