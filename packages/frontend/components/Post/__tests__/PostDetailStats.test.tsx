import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPostSummary, ReplyPermission } from '@mention/shared-types';
import PostDetailStats from '@/components/Post/PostDetailStats';
import { reportableReplyPermission } from '@/utils/postReplies';

/**
 * The pair that has to stay distinguishable under a focused post: a CHANNEL post
 * says nothing about replies, and a post whose AUTHOR closed them still says so.
 *
 * Rendered through `reportableReplyPermission` rather than by handing the prop a
 * literal, because the whole bug lives in the derivation. A channel post carries
 * `replyPermission: ['nobody']` on its own DTO — the server persists it as
 * defence in depth — so any test that passes the prop directly proves only that
 * `PostDetailStats` can be told to stay quiet, never that it IS.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}#${options.count}`,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666' } }),
}));

jest.mock('@oxyhq/bloom/pressable-scale', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});

// Never rendered below (no `postId` is passed), but it drags Bloom's untransformed
// ESM `avatar-group` into the module graph at import time.
jest.mock('@/components/Post/KnownLikersRow', () => ({ KnownLikersRow: () => null }));

const TIMESTAMP = '9:20 PM · Jun 11, 2026';

const CHANNEL: NonNullable<HydratedPostSummary['channel']> = {
  id: 'channel-1',
  handle: 'news',
  title: 'News',
  signPosts: true,
};

function makePost(overrides: {
  channel?: HydratedPostSummary['channel'];
  replyPermission?: ReplyPermission[];
}): HydratedPostSummary {
  return {
    id: 'post-1',
    metadata: {
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      visibility: 'public',
      ...(overrides.replyPermission ? { replyPermission: overrides.replyPermission } : {}),
    },
    ...(overrides.channel ? { channel: overrides.channel } : {}),
  } as HydratedPostSummary;
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

/**
 * Renders the block exactly the way `PostItem` does — the derivation included,
 * since that is the half under test. `postId` is deliberately omitted so the
 * known-likers row is never mounted and nothing is fetched.
 */
function render(post: HydratedPostSummary) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <PostDetailStats
        timestampLabel={TIMESTAMP}
        likes={0}
        boosts={0}
        quotes={0}
        saves={0}
        replyPermission={reportableReplyPermission(post)}
      />,
    );
  });
  if (!tree) throw new Error('PostDetailStats failed to render');
  return tree;
}

describe('PostDetailStats — the reply-restriction line', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('says NOTHING about replies on a channel post', () => {
    const tree = render(makePost({ channel: CHANNEL, replyPermission: ['nobody'] }));

    const text = textContent(tree);
    // Neither wording: replies being impossible is what a channel IS, so there
    // is no fact here to report and no reader to wonder who switched it off.
    expect(text).not.toContain('post.restrictions.repliesOff');
    expect(text).not.toContain('post.restrictions.repliesLimited');
    // The rest of the block is untouched — this suppresses one line, not the row.
    expect(text).toContain(TIMESTAMP);

    act(() => tree.unmount());
  });

  it('still says so when the AUTHOR closed replies', () => {
    const tree = render(makePost({ replyPermission: ['nobody'] }));

    // A choice somebody made, and the reader learning it from the post beats
    // learning it from a rejected reply. Losing this is the real regression.
    expect(textContent(tree)).toContain('post.restrictions.repliesOff');

    act(() => tree.unmount());
  });

  it('reports a narrowed audience, and nothing at all for the default', () => {
    const limited = render(makePost({ replyPermission: ['following'] }));
    expect(textContent(limited)).toContain('post.restrictions.repliesLimited');
    act(() => limited.unmount());

    const open = render(makePost({ replyPermission: ['anyone'] }));
    expect(textContent(open)).not.toContain('post.restrictions.replies');
    act(() => open.unmount());

    const unset = render(makePost({}));
    expect(textContent(unset)).not.toContain('post.restrictions.replies');
    act(() => unset.unmount());
  });

  /**
   * The channel case must not fall through to the `repliesLimited` branch
   * either. `['nobody']` is non-empty and does not contain `'anyone'`, so a fix
   * that only suppressed the `nobody` branch would swap one wrong sentence for
   * a worse one — and the first assertion above would still pass.
   */
  it('does not downgrade a channel post to "replies are limited"', () => {
    const tree = render(makePost({ channel: CHANNEL, replyPermission: ['following'] }));

    expect(textContent(tree)).not.toContain('post.restrictions.replies');

    act(() => tree.unmount());
  });
});
