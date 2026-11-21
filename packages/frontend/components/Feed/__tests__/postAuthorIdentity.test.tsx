import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * A post row shows the CURRENT picture and name of its author, not the one the
 * server happened to hydrate the post with.
 *
 * The bug these pin: changing a channel's picture saved correctly and then did
 * not appear on any of its posts until a full reload. The server is fine — it is
 * told about the write and re-asking returns the new picture — but nothing
 * re-asked, and a feed answer hydrated before the write put the old picture
 * back. A stored post now keeps only its author's id (`data/posts` refs), and the
 * author is the one copy the Oxy SDK's `User` holds, which keeps the copy with
 * the later `updatedAt`. The people a row holds its own copy of (the byline, the
 * reposter) are laid over by that same copy (`data/users`).
 *
 * `PostHeader` stands in for Bloom's avatar so the assertion reads the exact
 * values `PostItem` hands down. Everything else mocked here is mocked for one
 * reason only — it drags untransformed ESM into the module graph at import time
 * (the same reason `PostDetailStats.test.tsx` mocks its Bloom subpaths).
 */

jest.mock('@/lib/oxyServices', () => ({ oxyServices: {} }));
jest.mock('@/utils/api', () => ({ authenticatedClient: {}, publicClient: {} }));
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@oxy.so/bloom/hooks', () => ({ useImagePreload: () => undefined }));
jest.mock('@oxy.so/bloom/icons', () => ({
  RiChat3Fill: () => null,
  RiCornerDownRightLine: () => null,
  RiLinkM: () => null,
  RiMoreFill: () => null,
}));
jest.mock('@oxy.so/bloom/subtle-hover', () => ({
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
// The row reads its post from the account's store, as `usePostSelector` does.
jest.mock('@/stores/postsStore', () => ({
  usePostSelector: (postId?: string) => jest.requireActual('@/data/posts').usePost(postId),
}));
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
jest.mock('@/components/Post/PostLaneChip', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/ContentWarning', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostActions', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostDetailStats', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/Post/PostLocation', () => ({ __esModule: true, default: () => null }));
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
jest.mock('@/components/Post/PostHeader', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: (props: {
      avatarSource?: string | null;
      user?: { displayName?: string; handle?: string; kind?: string; character?: unknown };
      boostedBy?: { avatar?: string | null };
      authors?: { id: string; avatar?: string | null }[];
    }) =>
      ReactActual.createElement(
        ReactActual.Fragment,
        null,
        ReactActual.createElement(
          Text,
          { testID: 'author-identity' },
          `${props.avatarSource ?? ''}|${props.user?.displayName ?? ''}|${props.user?.handle ?? ''}`,
        ),
        ReactActual.createElement(
          Text,
          { testID: 'author-character' },
          JSON.stringify({ kind: props.user?.kind, character: props.user?.character }),
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

import PostItem from '../PostItem';
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { storeUsers } from '@oxy.so/services/ui/client';
import { storePosts } from '@/data/posts';

const CHANNEL_ID = 'channel-1';
/** When the server hydrated the posts below, and when the edit landed at Oxy. */
const HYDRATED_AT = '2026-08-01T00:00:00.000Z';
const EDITED_AT = '2026-08-02T00:00:00.000Z';

/** The channel as a post embeds it, hydrated before the edit. */
function channelBefore() {
  return {
    id: CHANNEL_ID,
    username: 'daily',
    name: { displayName: 'Daily' },
    avatar: 'avatar-before',
    kind: 'channel',
    updatedAt: HYDRATED_AT,
  };
}

/** One post authored by the channel, as the server hydrated it before the edit. */
function stalePost(id = 'post-1', user: Record<string, unknown> = channelBefore()) {
  return {
    id,
    content: {},
    attachments: {},
    metadata: { createdAt: '2026-08-02T00:00:00.000Z' },
    user,
  };
}

/**
 * An accepted profile write, as the SDK's account settings store Oxy's answer
 * in `User`: with the `updatedAt` Oxy gave it.
 */
function edit(person: { id: string; [field: string]: unknown }): void {
  storeUsers({ ...person, updatedAt: EDITED_AT });
}

/** Every row rendered by a test, unmounted by `afterEach` so no test leaks one. */
const mounted: TestRenderer.ReactTestRenderer[] = [];

/** A row for a post the account's store holds (stored first, as a feed does). */
function renderStoredRow(post = stalePost()) {
  act(() => {
    storePosts([post as never]);
  });
  return renderRow(post.id);
}

function renderRow(postId = 'post-1') {
  return mount(<PostItem post={stalePost(postId) as never} />);
}

function mount(element: React.ReactElement) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) throw new Error('the row did not render');
  mounted.push(renderer);
  return renderer;
}

function identityOf(renderer: TestRenderer.ReactTestRenderer): string {
  return String(renderer.root.findByProps({ testID: 'author-identity' }).props.children);
}

function probe(renderer: TestRenderer.ReactTestRenderer, testID: string): string {
  return String(renderer.root.findByProps({ testID }).props.children);
}

beforeEach(() => {
  setActiveStore(new Store());
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  jest.clearAllMocks();
});

describe('a post row follows its author’s identity', () => {
  it('shows the hydrated author when nothing has been edited', () => {
    const renderer = renderStoredRow();
    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');
  });

  it('repaints every MOUNTED post by that author when the profile is edited — no refetch, no new post data', () => {
    const first = renderStoredRow(stalePost('post-1'));
    const second = renderStoredRow(stalePost('post-2'));

    act(() => {
      edit({
        id: CHANNEL_ID,
        username: 'daily',
        name: { displayName: 'Daily Digest' },
        avatar: 'avatar-after',
      });
    });

    // Neither row was handed a new post, and nothing refetched.
    expect(identityOf(first)).toBe('avatar-after|Daily Digest|daily');
    expect(identityOf(second)).toBe('avatar-after|Daily Digest|daily');
  });

  it('shows the edited identity on a row mounted AFTER the edit', () => {
    act(() => {
      storePosts([stalePost() as never]);
      edit({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    expect(identityOf(renderRow())).toBe('avatar-after|Daily|daily');
  });

  it('keeps the edit when a feed answer hydrated before it arrives', () => {
    const renderer = renderStoredRow();
    act(() => {
      edit({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    // The channel's own page loads a page of its posts. Every one of them is
    // authored by the account whose picture just changed, and the server is
    // still answering with the old one.
    act(() => {
      storePosts([stalePost() as never, stalePost('post-2') as never]);
    });

    expect(identityOf(renderer)).toBe('avatar-after|Daily|daily');
  });

  it('takes a change made after the edit somewhere else', () => {
    const renderer = renderStoredRow();
    act(() => {
      edit({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    // Another device, or accounts.oxy.so, changed the picture again later.
    act(() => {
      storePosts([
        stalePost('post-1', {
          ...channelBefore(),
          avatar: 'avatar-elsewhere',
          updatedAt: '2026-08-03T00:00:00.000Z',
        }) as never,
      ]);
    });

    expect(identityOf(renderer)).toBe('avatar-elsewhere|Daily|daily');
  });

  it('never lets the "Unknown user" placeholder replace a resolved author', () => {
    const renderer = renderStoredRow();

    // An Oxy outage hydrates the author degraded, with no `updatedAt`.
    act(() => {
      storePosts([
        stalePost('post-2', {
          id: CHANNEL_ID,
          username: '',
          name: { displayName: 'Unknown user' },
          avatar: null,
        }) as never,
      ]);
    });

    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');
    expect(identityOf(renderRow('post-2'))).toBe('avatar-before|Daily|daily');
  });

  it('leaves every other author alone', () => {
    const renderer = renderStoredRow();

    act(() => {
      edit({ id: 'someone-else', avatar: 'avatar-after' });
    });

    expect(identityOf(renderer)).toBe('avatar-before|Daily|daily');
  });

  it('keeps each account’s people to that account', () => {
    const alice = new Store();
    const bob = new Store();

    setActiveStore(alice);
    act(() => {
      storePosts([stalePost() as never]);
      edit({ id: CHANNEL_ID, avatar: 'avatar-after' });
    });

    // Bob's store holds the same post as his own feed hydrated it.
    setActiveStore(bob);
    act(() => {
      storePosts([stalePost() as never]);
    });
    expect(identityOf(renderRow())).toBe('avatar-before|Daily|daily');

    setActiveStore(alice);
    expect(identityOf(renderRow())).toBe('avatar-after|Daily|daily');
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
    return mount(
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
                updatedAt: HYDRATED_AT,
              },
              {
                id: COLLABORATOR,
                username: 'co',
                name: { displayName: 'Co' },
                avatar: 'collab-before',
                updatedAt: HYDRATED_AT,
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
            updatedAt: HYDRATED_AT,
          } as never
        }
      />,
    );
  }

  it('starts from what the server hydrated', () => {
    const renderer = renderCollabRepost();
    expect(probe(renderer, 'booster-avatar')).toBe('booster-before');
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-before');
  });

  it('repaints the reposter when THEIR profile is edited', () => {
    const renderer = renderCollabRepost();

    act(() => {
      edit({ id: BOOSTER, avatar: 'booster-after' });
    });

    expect(probe(renderer, 'booster-avatar')).toBe('booster-after');
    // and nobody else moved
    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-before');
  });

  it('repaints one collaborator on the byline without touching the others', () => {
    const renderer = renderCollabRepost();

    act(() => {
      edit({ id: COLLABORATOR, avatar: 'collab-after' });
    });

    expect(probe(renderer, 'byline-avatars')).toBe('avatar-before,collab-after');
    expect(probe(renderer, 'booster-avatar')).toBe('booster-before');
  });

  it('draws one person the same way wherever they appear in the row', () => {
    const renderer = renderCollabRepost();

    // The channel is both the post's author and the first byline entry.
    act(() => {
      edit({ id: CHANNEL_ID, avatar: 'avatar-after' });
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
  const renderer = mount(<PostItem post={post as never} />);
  expect(probe(renderer, 'author-character')).toBe(JSON.stringify({ kind: 'bot', character }));
  const changed = { ...character, color: 'lime' };
  act(() => {
    renderer.update(
      <PostItem post={{ ...post, user: { ...post.user, character: changed } } as never} />,
    );
  });
  expect(probe(renderer, 'author-character')).toBe(
    JSON.stringify({ kind: 'bot', character: changed }),
  );
});
