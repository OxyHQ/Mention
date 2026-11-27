import type React from 'react';
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
 * The row's avatar and avatar cluster are stand-ins (below) so the assertions
 * read the exact values `PostItem` draws. Everything else mocked here is mocked for one
 * reason only — it drags untransformed ESM into the module graph at import time
 * (the same reason `PostDetailStats.test.tsx` mocks its Bloom subpaths).
 */

// The row's ⋯ menu reads the publisher's lanes from the services session, and
// the vote style from the persisted thread preferences: neither is the
// subject here, so the lanes are none and the storage is Jest's.
jest.mock('@/hooks/usePublisherLanes', () => ({
  usePublisherLanes: () => ({ lanes: [], isLoading: false }),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/lib/oxyServices', () => ({ oxyServices: {} }));
jest.mock('@/utils/api', () => ({ authenticatedClient: {}, publicClient: {} }));
jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
}));
jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
  useTheme: () => ({ colors: {} }),
}));
jest.mock('@oxy.so/bloom/hooks', () => ({
  ...jest.requireActual('@oxy.so/bloom/hooks'),
  useImagePreload: () => undefined,
}));
jest.mock('@oxy.so/bloom/subtle-hover', () => ({
  ...jest.requireActual('@oxy.so/bloom/subtle-hover'),
  SubtleHover: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
jest.mock('@/components/ProfileHoverCard', () => ({
  ProfileHoverCard: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/',
  // The row links its context lines; a link draws the element it wraps.
  Link: ({ children }: { children?: React.ReactNode }) => children,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/stores/postsStore', () => ({ usePostSelector: () => null }));
// The row's commands come from the app's one controller; these tests are about
// what the row RENDERS, so the commands are inert.
jest.mock('../postInteractions', () => {
  const commands = new Proxy({}, { get: () => () => undefined });
  return { usePostInteractions: () => commands };
});
jest.mock('@/hooks/usePostLanguage', () => ({
  usePostLanguage: () => ({
    options: [],
    activeTag: undefined,
    isTranslating: false,
    canTranslate: false,
    selectLanguage: () => undefined,
  }),
}));
jest.mock('@/components/Post/PostContentText', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/usePostLanguagePicker', () => ({
  usePostLanguagePicker: () => () => undefined,
}));
jest.mock('@/components/Post/PostLaneChip.bloom', () => ({
  __esModule: true,
  PostLaneChip: () => null,
}));
jest.mock('@/components/Post/ContentWarning.bloom', () => ({
  __esModule: true,
  ContentWarning: () => null,
}));
jest.mock('@/components/Post/PostActions.bloom', () => ({ __esModule: true, PostActions: () => null }));
jest.mock('@/components/Post/PostDetailStats', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostLocation', () => ({ __esModule: true, postLocation: () => null }));
jest.mock('@/components/Post/PostAttachmentsRow', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/common/ActionMenu', () => ({ showActionMenu: jest.fn() }));
jest.mock('@/utils/sheet', () => ({ presentSheet: jest.fn() }));
jest.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn(), setQueryData: jest.fn(), getQueryData: jest.fn() },
}));

/**
 * The identity slot of the post header, rendered as one string so a single
 * assertion covers the picture AND the name — a rename has exactly the same
 * problem as a new picture and is fixed by the same signal, so a test that
 * watched only the avatar would let half of it rot.
 */
// The row draws its author's avatar with `LiveAvatar` (the account it is handed
// carries the name, handle, kind and character), and a collaborative byline as
// one `AccountAvatarGroup` cluster. These stand-ins write what each is handed,
// so the assertions read the exact values the row draws.
jest.mock('@/components/ui/LiveAvatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    LiveAvatar: (props: {
      source?: string | null;
      account?: { displayName?: string; handle?: string; kind?: string; character?: unknown };
    }) =>
      ReactActual.createElement(
        ReactActual.Fragment,
        null,
        ReactActual.createElement(
          Text,
          { testID: 'author-identity' },
          `${props.source ?? ''}|${props.account?.displayName ?? ''}|${props.account?.handle ?? ''}`,
        ),
        ReactActual.createElement(
          Text,
          { testID: 'author-character' },
          JSON.stringify({ kind: props.account?.kind, character: props.account?.character }),
        ),
      ),
  };
});
jest.mock('@/components/ui/AccountAvatarGroup', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    // The cluster's lead is the author: its avatar, name and handle.
    AccountAvatarGroup: (props: {
      items: { uri?: string | null; displayName?: string; username?: string }[];
    }) =>
      ReactActual.createElement(
        ReactActual.Fragment,
        null,
        ReactActual.createElement(
          Text,
          { testID: 'author-identity' },
          `${props.items[0]?.uri ?? ''}|${props.items[0]?.displayName ?? ''}|${props.items[0]?.username ?? ''}`,
        ),
        ReactActual.createElement(
          Text,
          { testID: 'byline-avatars' },
          props.items.map((item) => item.uri ?? '').join(','),
        ),
      ),
  };
});

import PostItem from '../PostItem';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import { noteIdentityChanged } from '@/lib/actorCache';
import { openAccountStore, signOutForTests } from '@/test-support/accountScope';
import { resetIdentityUpdates } from '@/stores/identityUpdates';
// The subject draws language text, whose Painted leaf reads Bloom's theme from the app's provider.
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

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
    mounted = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={stalePost() as never} />}
      </BloomThemeProvider>,
    );
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

/** Every string the row draws, flattened: what a reader sees. */
function rowText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: TestRenderer.ReactTestRendererJSON | string): void => {
    if (typeof node === 'string') out.push(node);
    else node.children?.forEach(walk);
  };
  const tree = renderer.toJSON();
  (Array.isArray(tree) ? tree : tree ? [tree] : []).forEach(walk);
  return out.join('');
}

beforeEach(() => {
  openAccountStore();
});

afterEach(() => {
  const renderer = mounted;
  if (renderer) act(() => renderer.unmount());
  mounted = null;
  resetIdentityUpdates();
  signOutForTests();
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
        <BloomThemeProvider fonts={false}>
          {
            <PostItem
              post={
                {
                  ...stalePost(),
                  authors: [
                    {
                      id: CHANNEL_ID,
                      username: 'daily',
                      name: { displayName: 'Daily' },
                      avatar: 'avatar-before',
                    },
                    {
                      id: COLLABORATOR,
                      username: 'co',
                      name: { displayName: 'Co' },
                      avatar: 'collab-before',
                    },
                  ],
                } as never
              }
              repostedBy={
                {
                  id: BOOSTER,
                  username: 'boo',
                  name: { displayName: 'Boo' },
                  avatar: 'booster-before',
                } as never
              }
            />
          }
        </BloomThemeProvider>,
      );
    });
    if (!mounted) throw new Error('the row did not render');
    return mounted;
  }

  // The reposter is drawn by name, on the row's "Reposted by" line.
  it('starts from what the server hydrated', () => {
    const renderer = renderCollabRepost();
    expect(rowText(renderer)).toContain('Reposted by Boo');
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-before');
  });

  it('repaints the reposter when THEIR profile is edited', () => {
    const renderer = renderCollabRepost();

    act(() => {
      noteIdentityChanged({ id: BOOSTER, name: { displayName: 'Boo Radley' } });
    });

    expect(rowText(renderer)).toContain('Reposted by Boo Radley');
    // and nobody else moved
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-before');
  });

  it('repaints one collaborator on the byline without touching the others', () => {
    const renderer = renderCollabRepost();

    act(() => {
      noteIdentityChanged({ id: COLLABORATOR, avatar: 'collab-after' });
    });

    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-after');
    expect(rowText(renderer)).toContain('Reposted by Boo');
    expect(rowText(renderer)).not.toContain('Boo Radley');
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

it('repaints a changed character on the same post and author without engagement changes', () => {
  const character = {
    shape: 'rounded_head_two_ears',
    eyes: 'oval',
    color: 'teal',
    eyewear: 'none',
    accessory: 'none',
  };
  const before = stalePost();
  const post = { ...before, user: { ...before.user, kind: 'bot', character } };
  act(() => {
    mounted = TestRenderer.create(
      <BloomThemeProvider fonts={false}>{<PostItem post={post as never} />}</BloomThemeProvider>,
    );
  });
  expect(probe(mounted!, 'author-character')).toBe(JSON.stringify({ kind: 'bot', character }));
  const changed = { ...character, color: 'lime' };
  act(() => {
    mounted!.update(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={{ ...post, user: { ...post.user, character: changed } } as never} />}
      </BloomThemeProvider>,
    );
  });
  expect(probe(mounted!, 'author-character')).toBe(
    JSON.stringify({ kind: 'bot', character: changed }),
  );
});
