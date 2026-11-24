import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import { PostVisibility } from '@mention/shared-types';
import type { HydratedAuthor, HydratedPost } from '@mention/shared-types';

import PostItem from '../PostItem';
import { SubtleHover } from '@oxy.so/bloom/subtle-hover';
import { enterThreadHover, leaveThreadHover, useThreadHoverStore } from '@/stores/threadHoverStore';
// The subject draws language text, whose Painted leaf reads Bloom's theme from the app's provider.
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/**
 * The row's host element type must NOT depend on the route.
 *
 * `PostItem` used to pick `Pressable` or `View` from `usePathname()`. Two things
 * followed, and both were paid on every navigation: every mounted row re-rendered
 * (a hook subscription, which the memo comparator cannot stop), and the chosen
 * element type FLIPPED — a change of element type makes React unmount and remount
 * the whole subtree, so pushing `/p/<id>` remounted every visible feed row in the
 * same commit as the navigation.
 *
 * "Is this row a link" now rides on props (`isPostDetail`), so this test pins the
 * two halves that make that correct, and it needs both to mean anything:
 *
 *  1. THE TYPE IS THE SAME either way. Alone this is satisfiable by a component
 *     that ignores `isPostDetail` completely.
 *  2. THE BEHAVIOUR STILL DIFFERS — the focused post has no `onPress` and leaves
 *     the tab order. Alone this is satisfiable by the element swap this test
 *     exists to forbid.
 */

// The row's ⋯ menu reads the publisher's lanes from the services session, and
// the vote style from the persisted thread preferences: neither is the
// subject here, so the lanes are none and the storage is Jest's.
jest.mock('@/lib/oxyServices', () => ({ oxyServices: {} }));
jest.mock('@/utils/api', () => ({ authenticatedClient: {}, publicClient: {} }));
// The services session is not the subject: a signed-out viewer.
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: null, isAuthenticated: false, oxyServices: {} }),
  upsertCachedUser: jest.fn(),
  upsertCachedUsers: jest.fn(),
}));
jest.mock('@/hooks/usePublisherLanes', () => ({
  usePublisherLanes: () => ({ lanes: [], isLoading: false }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../../Post/PostHeader', () => ({
  __esModule: true,
  default: () => null,
}));

// No `usePathname`: the point of the change is that this component never asks.
// Exporting it here would let a reintroduced call pass unnoticed.
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
  // The row links its context lines; a link draws the element it wraps.
  Link: ({ children }: { children?: React.ReactNode }) => children,
}));

jest.mock('../../../stores/postsStore', () => ({ usePostSelector: () => undefined }));

jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
  useTheme: () => ({ colors: { textSecondary: '#8899a6', border: '#e1e8ed' } }),
}));
jest.mock('@oxy.so/bloom/hooks', () => ({
  ...jest.requireActual('@oxy.so/bloom/hooks'),
  useImagePreload: () => undefined,
}));
jest.mock('@oxy.so/bloom/subtle-hover', () => ({
  ...jest.requireActual('@oxy.so/bloom/subtle-hover'),
  SubtleHover: () => null,
}));

jest.mock('../../Post/PostContentText', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostLaneChip', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/ContentWarning', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostActions', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostDetailStats', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostLocation', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostAttachmentsRow', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ProfileHoverCard', () => ({
  ProfileHoverCard: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/hooks/usePostLanguagePicker', () => ({
  usePostLanguagePicker: () => () => undefined,
}));
// The row's commands come from the app's one controller; these tests are about
// what the row RENDERS, so the commands are inert.
const mockPostItemRenders = jest.fn();
jest.mock('../postInteractions', () => {
  const commands = new Proxy({}, { get: () => () => undefined });
  return {
    usePostInteractions: () => {
      mockPostItemRenders();
      return commands;
    },
  };
});
jest.mock('@/hooks/usePostLanguage', () => ({
  usePostLanguage: () => ({
    options: [],
    activeTag: null,
    displayText: null,
    isTranslating: false,
    isTranslated: false,
    canTranslate: false,
    selectLanguage: () => undefined,
    toggleReaderTranslation: () => undefined,
  }),
}));

jest.mock('@/components/common/ActionMenu', () => ({ showActionMenu: () => undefined }));
jest.mock('@/utils/sheet', () => ({ presentSheet: jest.fn() }));
jest.mock('@/utils/feedTelemetry', () => ({ reportFeedInteraction: () => undefined }));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const author: HydratedAuthor = {
  id: 'acct-nate',
  username: 'nate',
  kind: 'personal',
  name: { displayName: 'Nate Isern' },
  role: 'owner',
  status: 'accepted',
};

const post: HydratedPost = {
  id: 'post-1',
  user: author,
  authors: [author],
  content: { text: 'hola' },
  attachments: {},
  metadata: {
    visibility: PostVisibility.PUBLIC,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
  viewerState: {
    isOwner: false,
    isCollaborator: false,
    isLiked: false,
    isDownvoted: false,
    isBoosted: false,
    isSaved: false,
  },
  permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
};

/** The row root: the one element carrying the post's accessibility label. */
function renderRowRoot(isPostDetail: boolean) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={post} isPostDetail={isPostDetail} />}
      </BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('render produced no tree');
  const label = 'Nate Isern: hola';
  const roots = renderer.root.findAll((node) => node.props?.accessibilityLabel === label, {
    deep: false,
  });
  expect(roots).toHaveLength(1);
  return roots[0];
}

describe('PostItem row element', () => {
  it('renders the same element type whether or not it is the focused detail post', () => {
    const feedRow = renderRowRoot(false);
    const detailRow = renderRowRoot(true);

    // Before this was pinned the detail row was a `View` and the feed row a
    // `Pressable`; the swap between them is what remounted the feed on
    // navigation. Both clauses fail on that old code.
    expect(detailRow.type).toBe(feedRow.type);
    expect(detailRow.type).not.toBe(View);
  });

  it('still withholds navigation and focus from the focused detail post', () => {
    // The control for the test above: without this, "same element type" is also
    // satisfied by a component that ignores `isPostDetail` altogether.
    const feedRow = renderRowRoot(false);
    const detailRow = renderRowRoot(true);

    expect(typeof feedRow.props.onPress).toBe('function');
    // In the tab order: a pressable host is focusable unless it says otherwise.
    expect(feedRow.props.focusable).not.toBe(false);

    expect(detailRow.props.onPress).toBeUndefined();
    expect(detailRow.props.focusable).toBe(false);
  });
});

describe('thread hover isolation', () => {
  it('ignores a delayed leave for the same instance after its slice changed', () => {
    const owner = {};
    enterThreadHover('a', owner);
    enterThreadHover('b', owner);
    leaveThreadHover(owner, 'a');
    expect(useThreadHoverStore.getState().hoveredSliceKey).toBe('b');
    leaveThreadHover(owner, 'b');
    expect(useThreadHoverStore.getState().hoveredSliceKey).toBeNull();
  });

  it('releases a focused detail row even when no hover wash is rendered', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider fonts={false}>
          {<PostItem post={post} isThread isPostDetail sliceKey="detail" />}
        </BloomThemeProvider>,
      );
    });
    const row = renderer.root.findAll(
      (node) => node.props?.accessibilityLabel === 'Nate Isern: hola',
      { deep: false },
    )[0];
    expect(row.props.onPress).toBeUndefined();
    expect(row.findAllByType(SubtleHover)).toHaveLength(0);
    act(() => row.props.onHoverIn());
    expect(useThreadHoverStore.getState().hoveredSliceKey).toBe('detail');
    act(() => renderer.unmount());
    expect(useThreadHoverStore.getState().hoveredSliceKey).toBeNull();
  });

  it('subscribes only the thread overlays and keeps recycled rows synchronized', () => {
    const first = { ...post, id: 'first', content: { text: 'first' } };
    const second = { ...post, id: 'second', content: { text: 'second' } };
    // The same post may be mounted in two panes; ownership is per instance.
    const third = { ...post, id: 'first', content: { text: 'third' } };
    const standalone = { ...post, id: 'standalone', content: { text: 'standalone' } };
    const hookSpy = jest.spyOn(React, 'useSyncExternalStore');
    const tree = (
      firstThread: boolean,
      firstSlice: string,
      firstVisible = true,
      thirdVisible = true,
    ) => (
      <BloomThemeProvider fonts={false}>
        {firstVisible && (
          <PostItem
            key="first"
            post={first}
            isThread={firstThread}
            sliceKey={firstSlice}
            threadOpenId={`thread-${firstSlice}`}
          />
        )}
        <PostItem key="second" post={second} isThread sliceKey="a" threadOpenId="thread-a" />
        {thirdVisible && (
          <PostItem key="third" post={third} isThread sliceKey="b" threadOpenId="thread-b" />
        )}
        <PostItem key="standalone" post={standalone} />
      </BloomThemeProvider>
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      mockPostItemRenders.mockClear();
      act(() => {
        renderer = TestRenderer.create(tree(true, 'a'));
      });
      const hoverHookCalls = hookSpy.mock.calls.filter(
        ([subscribe]) => subscribe === useThreadHoverStore.subscribe,
      );
      expect(hoverHookCalls).toHaveLength(3);
      const rootFor = (text: string) => {
        const rows = renderer.root.findAll(
          (node) => node.props?.accessibilityLabel === `Nate Isern: ${text}`,
          { deep: false },
        );
        expect(rows).toHaveLength(1);
        return rows[0];
      };
      const activeFor = (text: string) => rootFor(text).findByType(SubtleHover).props.active;
      mockRouterPush.mockClear();
      act(() => rootFor('second').props.onPress());
      expect(mockRouterPush).toHaveBeenCalledWith('/p/thread-a');
      act(() => rootFor('standalone').props.onPress());
      expect(mockRouterPush).toHaveBeenLastCalledWith('/p/standalone');
      expect([
        activeFor('first'),
        activeFor('second'),
        activeFor('third'),
        activeFor('standalone'),
      ]).toEqual([false, false, false, undefined]);
      mockPostItemRenders.mockClear();
      act(() => rootFor('first').props.onHoverIn());
      expect([
        activeFor('first'),
        activeFor('second'),
        activeFor('third'),
        activeFor('standalone'),
      ]).toEqual([true, true, false, undefined]);
      expect(mockPostItemRenders).not.toHaveBeenCalled();
      // Another row in the same thread owns the newer gesture. Its hover must
      // survive a late leave and an unmount of the earlier owner.
      const lateFirstLeave = rootFor('first').props.onHoverOut;
      act(() => rootFor('second').props.onHoverIn());
      act(() => lateFirstLeave());
      expect([activeFor('first'), activeFor('second')]).toEqual([true, true]);
      act(() => renderer.update(tree(true, 'a', false)));
      expect(activeFor('second')).toBe(true);
      act(() => rootFor('second').props.onHoverOut());
      expect(activeFor('second')).toBe(false);
      act(() => renderer.update(tree(true, 'a')));
      act(() => rootFor('first').props.onHoverIn());
      act(() => renderer.update(tree(true, 'a', false)));
      expect(activeFor('second')).toBe(false);
      expect(useThreadHoverStore.getState().hoveredSliceKey).toBeNull();
      act(() => renderer.update(tree(true, 'a')));
      act(() => rootFor('third').props.onHoverIn());
      act(() => lateFirstLeave());
      expect(activeFor('third')).toBe(true);
      act(() => renderer.update(tree(true, 'b')));
      expect([activeFor('first'), activeFor('second'), activeFor('third')]).toEqual([
        true,
        false,
        true,
      ]);
      // The current owner disappearing clears its gesture even if a sibling of
      // the same slice stays mounted (as it can in a virtualized list).
      act(() => renderer.update(tree(true, 'b', true, false)));
      expect(activeFor('first')).toBe(false);
      expect(useThreadHoverStore.getState().hoveredSliceKey).toBeNull();
      act(() => renderer.update(tree(true, 'b')));
      act(() => rootFor('third').props.onHoverIn());
      act(() => renderer.update(tree(false, 'b')));
      expect(activeFor('first')).toBeUndefined();
      expect(rootFor('first').props.onHoverIn).toBeUndefined();
      mockPostItemRenders.mockClear();
      act(() => rootFor('second').props.onHoverIn());
      expect([activeFor('first'), activeFor('second'), activeFor('third')]).toEqual([
        undefined,
        true,
        false,
      ]);
      expect(mockPostItemRenders).not.toHaveBeenCalled();
    } finally {
      act(() => {
        renderer?.unmount();
        useThreadHoverStore.setState({ hoveredSliceKey: null, owner: null });
      });
      hookSpy.mockRestore();
    }
  });
});
