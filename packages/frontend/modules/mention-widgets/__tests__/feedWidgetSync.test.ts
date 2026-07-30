import type { HydratedPost } from '@mention/shared-types';

import {
  MAX_WIDGET_HANDOFF_POSTS,
  feedWidgetHandoffFor,
  syncFeedWidget,
  toWidgetFeedPosts,
} from '../feedWidgetSync';

/**
 * Which feed loads are handed to a home-screen widget, and what crosses the bridge.
 *
 * Nothing here touches Android — no store, no Glance composition and no launcher is
 * reachable from jest, and the rules that decide what a card DRAWS are Kotlin's
 * (`feedcard/FeedHandoffTest.kt` pins those, including that a handed-over post
 * produces exactly the same card as a fetched one). What is pinned here is the JS
 * half: which responses qualify at all, which account travels with one, and that the
 * projection carries every field the card rules read.
 */

const mockPublishTrending = jest.fn<Promise<void>, [string]>();
const mockPublishFollowing = jest.fn<Promise<void>, [string, string]>();
const mockDebug = jest.fn();

jest.mock('../index', () => ({
  publishTrendingWidgetFeed: (body: string) => mockPublishTrending(body),
  publishFollowingWidgetFeed: (accountId: string, body: string) =>
    mockPublishFollowing(accountId, body),
}));

jest.mock('@/lib/logger', () => ({
  logger: { debug: (...args: unknown[]) => mockDebug(...args) },
}));

const ACCOUNT = '6981c9178fcdefaf81988ffb';
const OTHER_ACCOUNT = '70a1d2e3f4b5c6d7e8f90001';

/** The fields of a hydrated post the projection reads; everything else is irrelevant here. */
function post(overrides: Partial<HydratedPost> = {}): HydratedPost {
  return {
    id: 'post_one',
    content: { text: 'A post' },
    attachments: {},
    user: { id: 'author', username: 'ada', name: { displayName: 'Ada' } },
    ...overrides,
  } as HydratedPost;
}

/** A first page of `count` posts, signed in as [ACCOUNT] — the shape that qualifies. */
function decision(overrides: Partial<Parameters<typeof feedWidgetHandoffFor>[0]> = {}) {
  return {
    descriptor: 'following' as const,
    cursor: undefined,
    viewerIdBefore: ACCOUNT,
    viewerIdAfter: ACCOUNT,
    postCount: 5,
    ...overrides,
  };
}

beforeEach(() => {
  mockPublishTrending.mockReset();
  mockPublishTrending.mockResolvedValue(undefined);
  mockPublishFollowing.mockReset();
  mockPublishFollowing.mockResolvedValue(undefined);
  mockDebug.mockReset();
});

describe('feedWidgetHandoffFor', () => {
  it('hands a following first page to the following widget, naming the account', () => {
    expect(feedWidgetHandoffFor(decision())).toEqual({
      widget: 'following',
      accountId: ACCOUNT,
    });
  });

  it('hands an explore first page to the trending widget with no account', () => {
    expect(feedWidgetHandoffFor(decision({ descriptor: 'explore' }))).toEqual({
      widget: 'trending',
    });
  });

  it('hands an explore page over for a signed-out reader too', () => {
    // Explore answers an unauthenticated request in full, which is the whole reason
    // that widget needs no session.
    expect(
      feedWidgetHandoffFor(
        decision({ descriptor: 'explore', viewerIdBefore: null, viewerIdAfter: null }),
      ),
    ).toEqual({ widget: 'trending' });
  });

  /**
   * `descriptor=following` answers an UNAUTHENTICATED request with 200 and zero posts,
   * so an empty page is exactly what a request whose bearer did not apply looks like.
   * Refusing it is what stops that case reaching a store.
   */
  it('refuses an empty page', () => {
    expect(feedWidgetHandoffFor(decision({ postCount: 0 }))).toBeNull();
    expect(feedWidgetHandoffFor(decision({ descriptor: 'explore', postCount: 0 }))).toBeNull();
  });

  it('refuses anything past the first page', () => {
    expect(feedWidgetHandoffFor(decision({ cursor: 'eyJjIjoxfQ' }))).toBeNull();
    expect(
      feedWidgetHandoffFor(decision({ descriptor: 'explore', cursor: 'eyJjIjoxfQ' })),
    ).toBeNull();
  });

  /**
   * A switch mid-flight leaves a page belonging to whichever account the server saw,
   * which this client can no longer assert. Dropped rather than guessed at — including
   * for the anonymous widget, whose page would then have been selected for somebody.
   */
  it('refuses a page whose identity moved while it was in flight', () => {
    expect(feedWidgetHandoffFor(decision({ viewerIdAfter: OTHER_ACCOUNT }))).toBeNull();
    expect(feedWidgetHandoffFor(decision({ viewerIdBefore: null }))).toBeNull();
    expect(
      feedWidgetHandoffFor(decision({ descriptor: 'explore', viewerIdAfter: null })),
    ).toBeNull();
  });

  it('refuses a following page fetched with no session', () => {
    expect(
      feedWidgetHandoffFor(decision({ viewerIdBefore: null, viewerIdAfter: null })),
    ).toBeNull();
  });

  /**
   * `for_you` is neither the Explore ranking the trending card is labelled with nor the
   * timeline the following card is labelled with. A card that says one thing while
   * showing another is worse than a card that is stale.
   */
  it('refuses every other descriptor, for_you included', () => {
    (['for_you', 'saved', 'videos', 'author|abc|posts'] as const).forEach((descriptor) => {
      expect(feedWidgetHandoffFor(decision({ descriptor }))).toBeNull();
    });
  });
});

describe('toWidgetFeedPosts', () => {
  it('carries every field the card rules read', () => {
    const projected = toWidgetFeedPosts([
      post({
        id: 'post_two',
        content: { text: 'Body text' },
        attachments: {
          media: [
            {
              id: 'file',
              type: 'image',
              url: 'https://cloud.oxy.so/file',
              thumbUrl: 'https://cloud.oxy.so/file?variant=w320',
              alt: 'Alt text',
            },
          ],
        },
        linkPreviews: [
          { url: 'https://example.test', title: 'Headline', image: 'https://img.test/1.jpg' },
        ],
        user: {
          id: 'author',
          username: 'verge@mastodon.social',
          name: { displayName: 'The Verge' },
          avatar: '6a30d42d0ef11d23d365ad09',
        },
      }),
    ]);

    expect(projected).toEqual([
      {
        id: 'post_two',
        text: 'Body text',
        title: 'Headline',
        thumbUrl: 'https://cloud.oxy.so/file?variant=w320',
        url: 'https://cloud.oxy.so/file',
        alt: 'Alt text',
        image: 'https://img.test/1.jpg',
        name: 'The Verge',
        username: 'verge@mastodon.social',
        avatar: '6a30d42d0ef11d23d365ad09',
      },
    ]);
  });

  /**
   * Absence has ONE spelling across the bridge. The native rules already read empty as
   * "there is none", so an `undefined` reaching them would be a second thing to get
   * right on both sides.
   */
  it('spells every absent field as an empty string, never undefined', () => {
    const [projected] = toWidgetFeedPosts([post({ content: {}, user: { id: 'a', name: {} } })]);

    expect(projected).toEqual({
      id: 'post_one',
      text: '',
      title: '',
      thumbUrl: '',
      url: '',
      alt: '',
      image: '',
      name: '',
      username: '',
      avatar: '',
    });
    Object.values(projected).forEach((value) => expect(typeof value).toBe('string'));
  });

  it('takes only the first media item and the first preview, because a card draws one picture', () => {
    const [projected] = toWidgetFeedPosts([
      post({
        attachments: {
          media: [
            { id: 'a', type: 'image', url: 'https://cloud.oxy.so/first' },
            { id: 'b', type: 'image', url: 'https://cloud.oxy.so/second' },
          ],
        },
        linkPreviews: [
          { url: 'https://one.test', title: 'First' },
          { url: 'https://two.test', title: 'Second' },
        ],
      }),
    ]);

    expect(projected.url).toBe('https://cloud.oxy.so/first');
    expect(projected.title).toBe('First');
  });

  /**
   * The widget keeps five and chooses them by which have pictures, so it needs a POOL —
   * but only as much of one as its own fetch asks for. Beyond that it is bytes crossing
   * the bridge the choice cannot reach.
   */
  it('caps the page at the pool the widget can actually choose from', () => {
    const page = Array.from({ length: MAX_WIDGET_HANDOFF_POSTS + 10 }, (_unused, index) =>
      post({ id: `post_${index}` }),
    );

    const projected = toWidgetFeedPosts(page);

    expect(projected).toHaveLength(MAX_WIDGET_HANDOFF_POSTS);
    expect(projected.at(-1)?.id).toBe(`post_${MAX_WIDGET_HANDOFF_POSTS - 1}`);
  });
});

describe('syncFeedWidget', () => {
  it('sends the following page under the account it was fetched as', () => {
    syncFeedWidget(decision(), [post({ id: 'post_three' })]);

    expect(mockPublishTrending).not.toHaveBeenCalled();
    expect(mockPublishFollowing).toHaveBeenCalledTimes(1);
    const [accountId, body] = mockPublishFollowing.mock.calls[0];
    expect(accountId).toBe(ACCOUNT);
    expect(JSON.parse(body)).toEqual(toWidgetFeedPosts([post({ id: 'post_three' })]));
  });

  it('sends an explore page to the trending widget alone', () => {
    syncFeedWidget(decision({ descriptor: 'explore' }), [post()]);

    expect(mockPublishFollowing).not.toHaveBeenCalled();
    expect(mockPublishTrending).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a response that does not qualify', () => {
    syncFeedWidget(decision({ descriptor: 'for_you' }), [post()]);
    syncFeedWidget(decision({ cursor: 'page-two' }), [post()]);
    syncFeedWidget(decision({ postCount: 0 }), []);

    expect(mockPublishTrending).not.toHaveBeenCalled();
    expect(mockPublishFollowing).not.toHaveBeenCalled();
  });

  /**
   * A home screen being a batch behind is not something to surface to a reader, but it
   * must stay visible in diagnostics — the same contract as the trends nudge.
   */
  it('swallows a native failure into a debug log rather than rejecting', async () => {
    mockPublishFollowing.mockRejectedValue(new Error('no widget host'));

    expect(() => syncFeedWidget(decision(), [post()])).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockDebug).toHaveBeenCalledWith(
      'Could not hand the feed to its home-screen widget',
      expect.objectContaining({ widget: 'following' }),
    );
  });
});
