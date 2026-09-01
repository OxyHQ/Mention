import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * A post row shows the CURRENT picture and name of its author, not the one the
 * server happened to hydrate the post with.
 *
 * The bug these pin: changing a channel's picture saved correctly and then did
 * not appear on any of its posts until a full reload. The server is fine — it is
 * told about the write and re-asking returns the new picture — but nothing
 * re-asks: `post.user` is frozen in the feed store's retained slice and in
 * SQLite, and a remount warm-starts from that slice instead of refetching page
 * 1. A reload was the only thing throwing all of it away.
 * `stores/identityUpdates` is what knows better, and `PostItem` is where a post
 * surface consults it — one place for feed rows, post details, quote cards and
 * boosted originals alike, since all four are this component.
 *
 * `PostHeader` stands in for Bloom's avatar so the assertion reads the exact
 * values `PostItem` hands down. Everything else mocked here is mocked for one
 * reason only — it drags untransformed ESM into the module graph at import time
 * (the same reason `PostDetailStats.test.tsx` mocks its Bloom subpaths).
 */

jest.mock('@/lib/oxyServices', () => ({ oxyServices: {} }));
jest.mock('@/utils/api', () => ({ authenticatedClient: {}, publicClient: {} }));
jest.mock('@oxyhq/services', () => ({
  upsertCachedUser: jest.fn(),
  upsertCachedUsers: jest.fn(),
}));
jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
jest.mock('@oxyhq/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@oxyhq/bloom/hooks', () => ({ useImagePreload: () => undefined }));
jest.mock('@oxyhq/bloom/subtle-hover', () => ({
  SubtleHover: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
jest.mock('@/components/ProfileHoverCard', () => ({
  ProfileHoverCard: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/stores/postsStore', () => ({ usePostSelector: () => null }));
jest.mock('@/hooks/usePostLike', () => ({ usePostLike: () => ({}) }));
jest.mock('@/hooks/usePostVote', () => ({ usePostVote: () => ({}) }));
jest.mock('@/hooks/usePostSave', () => ({ usePostSave: () => ({}) }));
jest.mock('@/hooks/usePostBoost', () => ({ usePostBoost: () => ({}) }));
jest.mock('@/hooks/usePostShare', () => ({ usePostShare: () => ({}) }));
jest.mock('@/hooks/usePostActions', () => ({ usePostActions: () => ({}) }));
jest.mock('@/hooks/usePostLanguage', () => ({
  usePostLanguage: () => ({
    options: [],
    activeTag: undefined,
    isTranslating: false,
    canTranslate: false,
    selectLanguage: () => undefined,
  }),
}));
jest.mock('@/context/BottomSheetContext', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return { BottomSheetContext: ReactActual.createContext(null) };
});
jest.mock('@/components/Post/PostContentText', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/usePostLanguagePicker', () => ({ usePostLanguagePicker: () => () => undefined }));
jest.mock('@/components/Post/PostLaneChip', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/ContentWarning', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostActions', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostDetailStats', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostLocation', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostAttachmentsRow', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/ActionMenu', () => ({ showActionMenu: jest.fn() }));
jest.mock('@/components/common/ContentDialog', () => ({ showContentDialog: jest.fn() }));
jest.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn(), setQueryData: jest.fn(), getQueryData: jest.fn() },
}));

/**
 * The identity slot of the post header, rendered as one string so a single
 * assertion covers the picture AND the name — a rename has exactly the same
 * problem as a new picture and is fixed by the same signal, so a test that
 * watched only the avatar would let half of it rot.
 */
jest.mock('@/components/Post/PostHeader', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    HEADER_CONTENT_GAP: 4,
    POST_CONTEXT_ROW_HEIGHT: 20,
    default: (props: {
      avatarSource?: string | null;
      user?: { displayName?: string; handle?: string };
      boostedBy?: { avatar?: string | null };
      authors?: { id: string; avatar?: string | null }[];
    }) =>
      ReactActual.createElement(ReactActual.Fragment, null,
        ReactActual.createElement(
          Text,
          { testID: 'author-identity' },
          `${props.avatarSource ?? ''}|${props.user?.displayName ?? ''}|${props.user?.handle ?? ''}`,
        ),
        ReactActual.createElement(
          Text,
          { testID: 'booster-avatar' },
          props.boostedBy?.avatar ?? '',
        ),
        ReactActual.createElement(
          Text,
          { testID: 'byline-avatars' },
          (props.authors ?? []).map((a) => a.avatar ?? '').join(','),
        ),
      ),
  };
});

// eslint-disable-next-line import/first
import PostItem from '../PostItem';
// eslint-disable-next-line import/first
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
// eslint-disable-next-line import/first
import { noteIdentityChanged } from '@/lib/actorCache';
// eslint-disable-next-line import/first
import { resetIdentityUpdates } from '@/stores/identityUpdates';

const CHANNEL_ID = 'channel-1';

/** One post authored by the channel, as the server hydrated it before the edit. */
function stalePost() {
  return {
    id: 'post-1',
    content: {},
    metadata: { createdAt: '2026-08-02T00:00:00.000Z' },
    user: {
      id: CHANNEL_ID,
      username: 'daily',
      name: { displayName: 'Daily' },
      avatar: 'avatar-before',
      kind: 'channel',
    },
  };
}

/** The row currently on screen, unmounted by `afterEach` so no test leaks one. */
let mounted: TestRenderer.ReactTestRenderer | null = null;

function renderRow() {
  act(() => {
    mounted = TestRenderer.create(<PostItem post={stalePost() as never} />);
  });
  if (!mounted) throw new Error('the row did not render');
  return mounted;
}

function identityOf(renderer: TestRenderer.ReactTestRenderer): string {
  return String(renderer.root.findByProps({ testID: 'author-identity' }).props.children);
}

function probe(renderer: TestRenderer.ReactTestRenderer, testID: string): string {
  return String(renderer.root.findByProps({ testID }).props.children);
}

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
  resetIdentityUpdates();
  jest.clearAllMocks();
});

describe('a post row follows its author’s identity', () => {
  it('shows the hydrated author when nothing has been edited', () => {
    const renderer = renderRow();
    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');
  });

  it('repaints a MOUNTED row when the author’s profile is edited — no refetch, no new post data', () => {
    const renderer = renderRow();
    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');

    act(() => {
      noteIdentityChanged({
        id: CHANNEL_ID,
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
      });
    });

    // The row was never handed a new post, and nothing refetched — the same
    // hydrated DTO is still its `post` prop.
    expect(identityOf(renderer)).toBe('avatar-after|Daily Digest|daily');
  });

  it('shows the edited identity on a row mounted AFTER the edit', () => {
    act(() => {
      noteIdentityChanged({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    const renderer = renderRow();
    expect(identityOf(renderer)).toBe('avatar-after|Daily|daily');
  });

  it('survives a later feed response that still carries the pre-edit author', () => {
    const renderer = renderRow();
    act(() => {
      noteIdentityChanged({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });
    expect(identityOf(renderer)).toBe('avatar-after|Daily|daily');

    // The channel's own page loads a page of its posts. Every one of them is
    // authored by the account whose picture just changed, and the server is
    // still answering with the old one.
    act(() => {
      precacheActorsFromPosts([stalePost()]);
    });

    expect(identityOf(renderer)).toBe('avatar-after|Daily|daily');
  });

  it('stands down once the server catches up, so a later change elsewhere is not pinned', () => {
    act(() => {
      noteIdentityChanged({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    // Hydration now carries the edit — the overlay has done its job.
    act(() => {
      precacheActorsFromPosts([
        { ...stalePost(), user: { ...stalePost().user, avatar: 'avatar-after' } },
      ]);
    });

    // A picture changed somewhere else afterwards (another device,
    // accounts.oxy.so) must not be overridden by what this session once wrote.
    const renderer = renderRow();
    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');
  });

  it('leaves every other author alone', () => {
    act(() => {
      noteIdentityChanged({ id: 'someone-else', avatar: 'avatar-after' });
    });

    const renderer = renderRow();
    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');
  });
});

/**
 * The row draws three actors, not one.
 *
 * `boostedBy` puts whoever reposted the post into the SAME avatar cluster as the
 * author, and a collaborative byline draws one avatar per collaborator there
 * too. Correcting only the author is more conspicuous than correcting nothing:
 * a collaborator who is also the author would be drawn twice, differently, in
 * one cluster.
 */
describe('every actor on the row follows its identity', () => {
  const BOOSTER = 'booster-1';
  const COLLABORATOR = 'collab-1';

  function renderCollabRepost() {
    act(() => {
      mounted = TestRenderer.create(
        <PostItem
          post={{
            ...stalePost(),
            authors: [
              { id: CHANNEL_ID, username: 'daily', name: { displayName: 'Daily' }, avatar: 'avatar-before' },
              { id: COLLABORATOR, username: 'co', name: { displayName: 'Co' }, avatar: 'collab-before' },
            ],
          } as never}
          repostedBy={{
            id: BOOSTER,
            username: 'boo',
            name: { displayName: 'Boo' },
            avatar: 'booster-before',
          } as never}
        />,
      );
    });
    if (!mounted) throw new Error('the row did not render');
    return mounted;
  }

  it('starts from what the server hydrated', () => {
    const renderer = renderCollabRepost();
    expect(probe(renderer, 'booster-avatar')).toBe('booster-before');
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-before');
  });

  it('repaints the reposter when THEIR profile is edited', () => {
    const renderer = renderCollabRepost();

    act(() => {
      noteIdentityChanged({ id: BOOSTER, avatar: 'booster-after' });
    });

    expect(probe(renderer, 'booster-avatar')).toBe('booster-after');
    // and nobody else moved
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-before');
  });

  it('repaints one collaborator on the byline without touching the others', () => {
    const renderer = renderCollabRepost();

    act(() => {
      noteIdentityChanged({ id: COLLABORATOR, avatar: 'collab-after' });
    });

    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-after');
    expect(probe(renderer, 'booster-avatar')).toBe('booster-before');
  });

  it('draws one person the same way wherever they appear in the row', () => {
    const renderer = renderCollabRepost();

    // The channel is both the post's author and the first byline entry.
    act(() => {
      noteIdentityChanged({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    expect(identityOf(renderer)).toBe('avatar-after|Daily|daily');
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-after,collab-before');
  });
});
