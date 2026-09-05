import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import { PostVisibility } from '@mention/shared-types';
import type { HydratedAuthor, HydratedPost } from '@mention/shared-types';

import PostItem from '../PostItem';

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

jest.mock('../../Post/PostHeader', () => ({
  __esModule: true,
  default: () => null,
  HEADER_CONTENT_GAP: 4,
  POST_CONTEXT_ROW_HEIGHT: 18,
}));

// No `usePathname`: the point of the change is that this component never asks.
// Exporting it here would let a reintroduced call pass unnoticed.
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('../../../stores/postsStore', () => ({ usePostSelector: () => undefined }));

jest.mock('@/stores/threadHoverStore', () => ({
  useThreadHoverStore: (selector: (state: unknown) => unknown) =>
    selector({ setHoveredSlice: () => undefined, hoveredSliceKey: null }),
}));

jest.mock('@oxyhq/bloom/bottom-sheet', () => ({ BottomSheet: 'BottomSheet' }));
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#8899a6', border: '#e1e8ed' } }),
}));
jest.mock('@oxyhq/bloom/hooks', () => ({ useImagePreload: () => undefined }));
jest.mock('@oxyhq/bloom/subtle-hover', () => ({ SubtleHover: () => null }));

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@/assets/icons/pin-icon', () => ({ PinIcon: () => null }));
jest.mock('@/assets/icons/boost-icon', () => ({ BoostIcon: () => null }));

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

jest.mock('@/hooks/usePostLanguagePicker', () => ({ usePostLanguagePicker: () => () => undefined }));
jest.mock('@/hooks/usePostLike', () => ({ usePostLike: () => () => undefined }));
jest.mock('@/hooks/usePostVote', () => ({
  usePostVote: () => ({ toggleDownvote: () => undefined }),
}));
jest.mock('@/hooks/usePostSave', () => ({ usePostSave: () => () => undefined }));
jest.mock('@/hooks/usePostBoost', () => ({ usePostBoost: () => () => undefined }));
jest.mock('@/hooks/usePostShare', () => ({ usePostShare: () => () => undefined }));
jest.mock('@/hooks/usePostActions', () => ({ usePostActions: () => ({}) }));
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
jest.mock('@/components/common/ContentDialog', () => ({ showContentDialog: () => undefined }));
jest.mock('@/utils/feedTelemetry', () => ({ reportFeedInteraction: () => undefined }));

jest.mock('@oxyhq/core', () => ({
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
    renderer = TestRenderer.create(<PostItem post={post} isPostDetail={isPostDetail} />);
  });
  if (!renderer) throw new Error('render produced no tree');
  const label = 'Nate Isern: hola';
  const roots = renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === label,
    { deep: false },
  );
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
    expect(feedRow.props.focusable).toBe(true);

    expect(detailRow.props.onPress).toBeUndefined();
    expect(detailRow.props.focusable).toBe(false);
  });
});
