import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPostSummary, ReplyPermission } from '@mention/shared-types';
import PostDetailStats from '@/components/Post/PostDetailStats';
import { reportableReplyPermission } from '@/utils/postReplies';

/**
 * The pair that has to stay distinguishable under a focused post: a post whose
 * AUTHOR closed replies says so, and one the SERVER simply refused the viewer
 * (a channel account's post, an audience the viewer is outside of) says nothing
 * — there is no decision to report.
 *
 * Rendered through `reportableReplyPermission` rather than by handing the prop a
 * literal, because the whole bug lives in the derivation: passing the prop
 * directly proves only that `PostDetailStats` can be told to stay quiet, never
 * that it IS.
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

function makePost(overrides: {
  canReply?: boolean;
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
    ...(overrides.canReply === undefined ? {} : { permissions: { canReply: overrides.canReply } }),
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

  it('says NOTHING about replies when only the server refused them', () => {
    // The shape a CHANNEL account's post arrives in: the server says no, the
    // author set nothing.
    const tree = render(makePost({ canReply: false }));

    const text = textContent(tree);
    // Neither wording: nobody switched anything off, so there is no fact here to
    // report and no reader to wonder who did.
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
   * A server refusal must not SUPPRESS the author's own restriction either: the
   * two are independent, and the audience the author chose stays worth saying
   * even to a reader who falls outside it — that is precisely who benefits from
   * reading it rather than discovering it from a rejected reply.
   */
  it('still reports the author\'s narrowed audience to a viewer outside it', () => {
    const tree = render(makePost({ canReply: false, replyPermission: ['following'] }));

    expect(textContent(tree)).toContain('post.restrictions.repliesLimited');

    act(() => tree.unmount());
  });
});
