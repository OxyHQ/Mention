/**
 * After the viewer publishes, the feed their post lands in brings it into view —
 * once, the next time that feed is in front (OxyHQ/Mention#1140: the new post sat
 * above the fold, cut off under the header).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost } from '@mention/shared-types';
import { publishNewLocalPost } from '@/stores/feedScrollStore';
import {
  feedReceivesOwnNewPost,
  resetRevealOwnNewPost,
  useRevealOwnNewPost,
} from '../useRevealOwnNewPost';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(props: { feedKey: string; enabled: boolean; scrollToTop: () => void }) {
  useRevealOwnNewPost(props);
  return null;
}

const post = { id: 'new', user: { id: 'viewer' } } as unknown as HydratedPost;

function frame(): void {
  act(() => {
    jest.runOnlyPendingTimers();
  });
}

describe('useRevealOwnNewPost', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetRevealOwnNewPost();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits until the feed is in front, scrolls once, and not again', () => {
    const scrollToTop = jest.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Probe feedKey="home" enabled={false} scrollToTop={scrollToTop} />);
    });

    // Published from the composer, while the feed is behind it.
    act(() => publishNewLocalPost(post));
    frame();
    expect(scrollToTop).not.toHaveBeenCalled();

    // Back in front.
    act(() => tree.update(<Probe feedKey="home" enabled scrollToTop={scrollToTop} />));
    frame();
    expect(scrollToTop).toHaveBeenCalledTimes(1);

    // Leaving and coming back does not yank the reader to the top again.
    act(() => tree.update(<Probe feedKey="home" enabled={false} scrollToTop={scrollToTop} />));
    act(() => tree.update(<Probe feedKey="home" enabled scrollToTop={scrollToTop} />));
    frame();
    expect(scrollToTop).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('is answered by a feed that REMOUNTS after the publish (web unmounts it under the composer)', () => {
    act(() => publishNewLocalPost(post));

    const scrollToTop = jest.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Probe feedKey="home-web" enabled scrollToTop={scrollToTop} />);
    });
    frame();
    expect(scrollToTop).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });
});

describe('feedReceivesOwnNewPost', () => {
  it('is the home feeds and the viewer’s own profile posts — where createPost inserts it', () => {
    expect(feedReceivesOwnNewPost({ type: 'for_you' })).toBe(true);
    expect(feedReceivesOwnNewPost({ type: 'following' })).toBe(true);
    expect(feedReceivesOwnNewPost({ type: 'posts', userId: 'me', currentUserId: 'me' })).toBe(true);
  });

  it('is never someone else’s profile, a scoped feed, or the saved feed', () => {
    expect(feedReceivesOwnNewPost({ type: 'posts', userId: 'ana', currentUserId: 'me' })).toBe(false);
    expect(feedReceivesOwnNewPost({ type: 'replies', filters: { postId: 'p' } })).toBe(false);
    expect(feedReceivesOwnNewPost({ type: 'for_you', showOnlySaved: true })).toBe(false);
    expect(feedReceivesOwnNewPost({ type: 'likes', userId: 'me', currentUserId: 'me' })).toBe(false);
  });
});
