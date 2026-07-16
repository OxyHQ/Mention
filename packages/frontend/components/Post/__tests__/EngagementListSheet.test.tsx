import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PostUser } from '@mention/shared-types';

/**
 * Regression harness for the "likes/boosts list shows every engager as
 * 'Unknown user'" bug.
 *
 * The engagement endpoints (`GET /posts/:id/likes` and `.../boosts`) return the
 * canonical Oxy {@link PostUser} per engager — `username` + structured
 * `name.displayName` (same shape as `post.user`). A refactor (`c7184d5b`) moved
 * the backend to that shape but LEFT this sheet reading the old flat fields
 * (`item.handle`, `item.displayName`), which do not exist on a `PostUser`. Every
 * row was handed `{ handle: undefined, name: { displayName: undefined } }`, so
 * `ProfileCard` fell back to "Unknown user" for BOTH local and federated
 * engagers — regardless of whether Oxy resolved them.
 *
 * The sheet must forward the PostUser fields (`username` / `name`) so a real
 * display name renders, and a federated engager with no display name renders its
 * `@user@domain` handle. This test reproduces `ProfileCard`'s own label decision
 * so a re-broken field mapping renders "Unknown user" here exactly as it does in
 * the app.
 */

// A faithful copy of `getNormalizedUserHandle` from `@oxyhq/core` (local users
// resolve to `username`; federated to `username@instance`). `@oxyhq/core` is not
// transformed in this suite, so it is mocked — but with the REAL logic, so the
// federated handle path is genuinely exercised.
function mockNormalizeHandlePart(value?: string | null): string | null {
  const trimmed = value?.trim().replace(/^@+/, '');
  if (!trimmed || /[/?#]/.test(trimmed)) return null;
  return trimmed;
}
function mockNormalizedHandle(user: {
  username?: string | null;
  handle?: string | null;
  instance?: string | null;
  isFederated?: boolean | null;
  federation?: { domain?: string | null } | null;
} | null | undefined): string | null {
  const username = mockNormalizeHandlePart(user?.username ?? user?.handle);
  if (!username) return null;
  const isFederated = user?.isFederated === true;
  const instance = mockNormalizeHandlePart(user?.instance ?? user?.federation?.domain);
  if (isFederated && instance && !username.includes('@')) return `${username}@${instance}`;
  return username;
}

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: unknown) =>
    mockNormalizedHandle(user as Parameters<typeof mockNormalizedHandle>[0]),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockGetPostLikes = jest.fn();
const mockGetPostBoosts = jest.fn();
jest.mock('@/services/feedService', () => ({
  feedService: {
    getPostLikes: (...args: unknown[]) => mockGetPostLikes(...args),
    getPostBoosts: (...args: unknown[]) => mockGetPostBoosts(...args),
  },
}));

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Header/close/loading/empty-state are chrome — render nothing.
jest.mock('@/components/Header', () => ({ Header: () => null }));
jest.mock('@/components/ui/Button', () => ({ IconButton: () => null }));
jest.mock('@/assets/icons/close-icon', () => ({ CloseIcon: () => null }));
jest.mock('@oxyhq/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));

// The skeleton list stands in for the loading branch; render nothing so only the
// real (loaded) rows show up in the tree.
jest.mock('@/components/ProfileCard', () => {
  const { Text: RNText } = jest.requireActual<typeof import('react-native')>('react-native');
  // Faithful reproduction of ProfileCard's primary-label decision: a real display
  // name wins; otherwise the `@handle`; otherwise "Unknown user".
  const ProfileCard = ({ profile }: { profile: Record<string, unknown> }) => {
    const handle = mockNormalizedHandle(profile as Parameters<typeof mockNormalizedHandle>[0]) ?? '';
    const name = profile.name as { displayName?: string } | undefined;
    const displayName = name?.displayName?.trim();
    const primaryLabel = displayName || (handle ? `@${handle}` : 'Unknown user');
    mockCapturedProfiles.push(profile);
    return <RNText>{primaryLabel}</RNText>;
  };
  return {
    ProfileCard,
    ProfileCardSkeletonList: () => null,
  };
});

const mockCapturedProfiles: Array<Record<string, unknown>> = [];

import EngagementListSheet from '../EngagementListSheet';

/** A federated booster with NO display name — must render its @user@domain handle. */
const federatedEngager: PostUser = {
  id: 'fed-1',
  username: 'gargron@mastodon.social',
  name: {},
  avatar: '6a2d8cba75125544a42f285d',
  verified: false,
  isFederated: true,
  instance: 'mastodon.social',
  federation: { domain: 'mastodon.social' },
};

/** A local engager with a real display name. */
const localEngager: PostUser = {
  id: 'loc-1',
  username: 'oxy',
  name: { displayName: 'Oxy' },
  avatar: '69b85ff8a08af16d4b87155e',
  verified: true,
};

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderedTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('EngagementListSheet — canonical PostUser rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCapturedProfiles.length = 0;
  });

  it('renders the boosts list from canonical PostUser objects — real name and federated handle, never "Unknown user"', async () => {
    mockGetPostBoosts.mockResolvedValue({
      users: [federatedEngager, localEngager],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 2,
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <EngagementListSheet postId="post-1" type="boosts" onClose={jest.fn()} />,
      );
    });
    await flush();

    const texts = renderedTexts(renderer);

    // The end-user outcome: a local engager shows its display name, a federated
    // engager with no display name shows its @user@domain handle.
    expect(texts).toContain('Oxy');
    expect(texts).toContain('@gargron@mastodon.social');
    // The exact regression: no row degrades to the neutral placeholder.
    expect(texts).not.toContain('Unknown user');

    // Structural guard: the sheet forwards the PostUser identity fields
    // (`username` + structured `name`), not the old flat `{ handle, displayName }`
    // — the latter left `username` undefined, which is what produced "Unknown user".
    const fed = mockCapturedProfiles.find((p) => p.id === 'fed-1');
    expect(fed?.username).toBe('gargron@mastodon.social');
    expect(fed?.name).toEqual({});
    expect(fed?.instance).toBe('mastodon.social');
    expect((fed?.federation as { domain?: string } | undefined)?.domain).toBe('mastodon.social');

    const local = mockCapturedProfiles.find((p) => p.id === 'loc-1');
    expect((local?.name as { displayName?: string } | undefined)?.displayName).toBe('Oxy');
    expect(local?.username).toBe('oxy');
  });

  it('likes list uses the same canonical shape', async () => {
    mockGetPostLikes.mockResolvedValue({
      users: [federatedEngager],
      hasMore: false,
      nextCursor: undefined,
      totalCount: 1,
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <EngagementListSheet postId="post-1" type="likes" onClose={jest.fn()} />,
      );
    });
    await flush();

    expect(mockGetPostLikes).toHaveBeenCalledWith('post-1', undefined);
    expect(renderedTexts(renderer)).toContain('@gargron@mastodon.social');
    expect(renderedTexts(renderer)).not.toContain('Unknown user');
  });
});
