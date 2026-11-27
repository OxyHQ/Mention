import type React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { PostVisibility } from '@mention/shared-types';
import type { HydratedAuthor, HydratedPost, PostUser } from '@mention/shared-types';

import PostItem from '../PostItem';
import type { NestedPostRenderer } from '../../Post/Attachments/PostAttachmentNested';
// The subject draws language text, whose Painted leaf reads Bloom's theme from the app's provider.
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/**
 * `PostItem` decides two things about authorship that only it can see:
 *
 *  1. WHICH HEADING the author dialog opens with. A signed channel post reaches
 *     the same panel as a collaboration, and only the byline roles distinguish
 *     them — `writer` exists on no other byline, so it, not the account kind, is
 *     what picks "Published by" over "Collaborators".
 *  2. THAT THE BOOSTER REACHES THE AVATAR CLUSTER AT ALL. The row pairs and
 *     reorders the cluster from the booster; the wire once sat declared and
 *     unpassed, so every one of those rules was dead code in the app. This pins
 *     the wire, and pins that the id in it is the one `HydratedAuthor.id` is
 *     compared against — the two coming from different id spaces is the failure
 *     that reorders nothing, silently.
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
// The services session is not the subject: a signed-out viewer.
jest.mock('@oxy.so/services/ui/client', () => ({
  ...require('@/test-support/oxyUsers').oxyUsers,
  useAuth: () => ({ user: null, isAuthenticated: false, oxyServices: {} }),
}));

/**
 * The row draws its avatar column itself: one author is a `LiveAvatar`, a
 * collaborative byline (or an author beside the booster) one
 * `AccountAvatarGroup` cluster. These stand-ins record what each is handed.
 */
interface CapturedCluster {
  items: { id: string }[];
}
const mockClusters: CapturedCluster[] = [];
const mockAvatars: { userId?: string }[] = [];
jest.mock('@/components/ui/AccountAvatarGroup', () => ({
  AccountAvatarGroup: (props: CapturedCluster) => {
    mockClusters.push(props);
    return null;
  },
}));
jest.mock('@/components/ui/LiveAvatar', () => ({
  LiveAvatar: (props: { userId?: string }) => {
    mockAvatars.push(props);
    return null;
  },
}));

/**
 * How the test reads what `PostItem` handed the dialog surface: a `<Suspense>`
 * wrapping the lazy author panel. The panel's own `title` is a SEPARATE prop
 * from the dialog's `label`, and a fix that sets only one leaves the other's
 * header wrong, so both are read.
 */
interface AuthorPanelProps {
  title?: string;
}
interface CapturedDialog {
  label: string;
  render: (
    close: () => void,
  ) => React.ReactElement<{ children?: React.ReactElement<AuthorPanelProps> }>;
}
const mockDialogs: CapturedDialog[] = [];
jest.mock('@/utils/sheet', () => ({
  presentSheet: (
    render: (surface: { dismiss: () => void }) => React.ReactElement,
    options?: { label?: string },
  ) => {
    mockDialogs.push({
      label: options?.label ?? '',
      render: (close) => render({ dismiss: close }) as ReturnType<CapturedDialog['render']>,
    });
    return Promise.resolve();
  },
}));

jest.mock('expo-router', () => ({
  // The row links its context lines; a link draws the element it wraps.
  Link: ({ children }: { children?: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/',
}));

jest.mock('../../../stores/postsStore', () => ({ usePostSelector: () => undefined }));

jest.mock('@/stores/threadHoverStore', () => ({
  useThreadHoverStore: (selector: (state: unknown) => unknown) =>
    selector({ setHoveredSlice: () => undefined, hoveredSliceKey: null }),
}));

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

jest.mock('../../Post/PostContentText', () => ({ __esModule: true, default: 'PostContentText' }));
jest.mock('../../Post/PostLaneChip.bloom', () => ({ __esModule: true, PostLaneChip: () => null }));
jest.mock('../../Post/ContentWarning.bloom', () => ({
  __esModule: true,
  ContentWarning: () => null,
}));
jest.mock('../../Post/PostActions', () => ({ __esModule: true, default: 'PostActions' }));
jest.mock('../../Post/PostDetailStats', () => ({ __esModule: true, default: 'PostDetailStats' }));
jest.mock('../../Post/PostLocation', () => ({ __esModule: true, postLocation: () => null }));
jest.mock('../../Post/PostAttachmentsRow', () => ({
  __esModule: true,
  default: ({
    nestedPost,
    nestingDepth,
    renderNestedPost,
  }: {
    nestedPost?: HydratedPost;
    nestingDepth: number;
    renderNestedPost?: NestedPostRenderer;
  }) => {
    if (!nestedPost || !renderNestedPost) return null;
    const Nested = jest.requireActual('../../Post/Attachments/PostAttachmentNested').default;
    return (
      <Nested nestedPost={nestedPost} nestingDepth={nestingDepth} renderPost={renderNestedPost} />
    );
  },
}));
jest.mock('@/hooks/usePostLanguagePicker', () => ({
  usePostLanguagePicker: () => () => undefined,
}));
jest.mock('../../ProfileHoverCard', () => ({
  ProfileHoverCard: ({ children }: { children: React.ReactNode }) => children,
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
jest.mock('@/utils/feedTelemetry', () => ({ reportFeedInteraction: () => undefined }));

jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));

// Resolves against the real `en.json` and ignores `defaultValue`: the headings
// are the assertion, so a deleted key must render its raw name and fail rather
// than fall back to a default that reads identically.
jest.mock('react-i18next', () => {
  const i18n = require('i18next').createInstance();
  i18n.init({
    lng: 'en',
    keySeparator: false,
    initImmediate: false,
    resources: { en: { translation: require('@/locales/en.json') } },
  });
  return { useTranslation: () => ({ t: i18n.t.bind(i18n) }) };
});

// --- fixtures ---

const channel: HydratedAuthor = {
  id: 'acct-notas',
  username: 'notas',
  kind: 'channel',
  name: { displayName: 'Notas de Nate' },
  role: 'owner',
  status: 'accepted',
};

const writer: HydratedAuthor = {
  id: 'acct-nate',
  username: 'nate',
  kind: 'personal',
  name: { displayName: 'Nate Isern' },
  role: 'writer',
  status: 'accepted',
};

const owner: HydratedAuthor = {
  id: 'acct-ana',
  username: 'ana',
  kind: 'personal',
  name: { displayName: 'Ana Torres' },
  role: 'owner',
  status: 'accepted',
};

const collaborator: HydratedAuthor = {
  id: 'acct-luis',
  username: 'luis',
  kind: 'personal',
  name: { displayName: 'Luis Prado' },
  role: 'collaborator',
  status: 'accepted',
};

const boosterUser: PostUser = {
  id: 'acct-mar',
  username: 'mar',
  kind: 'personal',
  name: { displayName: 'Mar Ruiz' },
};

function postWith(authors: HydratedAuthor[]): HydratedPost {
  return {
    id: 'post-1',
    user: authors[0],
    authors,
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
}

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('Post render did not complete');
  return renderer;
}

/** The avatar cluster this render produced: its members' ids, lead first. */
function lastCluster(): string[] | undefined {
  return mockClusters[mockClusters.length - 1]?.items.map((item) => item.id);
}

/** The cluster's press, which opens the author dialog (a collaborative byline only). */
function collaboratorsControl(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'View collaborators' &&
      typeof node.props.onPress === 'function',
  )[0];
}

/**
 * Opens the author dialog the way the avatar cluster does. The element tree is
 * read rather than rendered: the panel is `lazy()`, so resolving it would only
 * re-assert the prop through another mock.
 */
function openAuthorDialog(renderer: TestRenderer.ReactTestRenderer): {
  label: string;
  panelTitle?: string;
} {
  act(() => {
    collaboratorsControl(renderer).props.onPress();
  });
  const dialog = mockDialogs[mockDialogs.length - 1];
  return {
    label: dialog.label,
    panelTitle: dialog.render(() => undefined).props.children?.props.title,
  };
}

describe('PostItem author dialog heading', () => {
  beforeEach(() => {
    mockClusters.length = 0;
    mockAvatars.length = 0;
    mockDialogs.length = 0;
  });

  it('says "Published by" when the byline names a writer — nobody co-authored anything', () => {
    const renderer = render(<PostItem post={postWith([channel, writer])} />);
    expect(openAuthorDialog(renderer)).toEqual({
      label: 'Published by',
      panelTitle: 'Published by',
    });
  });

  it('says "Collaborators" for a genuine collaboration', () => {
    const renderer = render(<PostItem post={postWith([owner, collaborator])} />);
    expect(openAuthorDialog(renderer)).toEqual({
      label: 'Collaborators',
      panelTitle: 'Collaborators',
    });
  });

  it('does not open at all for a solo post', () => {
    const renderer = render(<PostItem post={postWith([owner])} />);
    expect(collaboratorsControl(renderer)).toBeUndefined();
  });
});

describe('PostItem boost wiring', () => {
  beforeEach(() => {
    mockClusters.length = 0;
    mockAvatars.length = 0;
    mockDialogs.length = 0;
  });

  it('leads the cluster with the BOOSTER, in the id space the authors carry', () => {
    // `feedRows` unwraps a boost into (original post, `repostedBy` = the boost
    // actor), and both that actor and every `authors[]` entry are the canonical
    // Oxy `PostUser` keyed by Oxy user id — so the row's `id` comparison finds
    // a match when there is one, and moves the booster to the lead.
    render(<PostItem post={postWith([channel, writer])} repostedBy={writer} />);
    expect(lastCluster()).toEqual([writer.id, channel.id]);
  });

  it('draws an outside booster beside a solo author', () => {
    render(<PostItem post={postWith([owner])} repostedBy={boosterUser} />);
    expect(lastCluster()).toEqual([owner.id, boosterUser.id]);
  });

  it('leaves the byline in its order when no boost surfaced the row', () => {
    render(<PostItem post={postWith([channel, writer])} />);
    expect(lastCluster()).toEqual([channel.id, writer.id]);
  });
});

it('renders a hydrated quote in the same commit as its parent, without an empty suspense frame', () => {
  mockAvatars.length = 0;
  const quote = { ...postWith([writer]), id: 'quoted-post' };
  render(<PostItem post={{ ...postWith([owner]), quotedPost: quote }} />);
  // One commit drew both rows' avatars: the parent's author, then the quote's.
  expect(mockAvatars.map((avatar) => avatar.userId)).toEqual([owner.id, writer.id]);
});

it.each([false, true])(
  'updates quote availability without editing its parent (detail=%s)',
  (isPostDetail) => {
    const parent = postWith([owner]);
    const quote = {
      ...postWith([writer]),
      id: 'quoted-post',
      content: { text: 'Quoted original' },
    };
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider fonts={false}>
          {<PostItem post={parent} isPostDetail={isPostDetail} />}
        </BloomThemeProvider>,
      );
    });
    if (!renderer) throw new Error('Post render did not complete');
    const tree = renderer;
    const text = () => JSON.stringify(tree.toJSON());
    expect(text()).not.toContain('Quoted original');
    act(() =>
      tree.update(
        <BloomThemeProvider fonts={false}>
          {<PostItem post={{ ...parent, quotedPost: quote }} isPostDetail={isPostDetail} />}
        </BloomThemeProvider>,
      ),
    );
    expect(text()).toContain('Quoted original');
    act(() =>
      tree.update(
        <BloomThemeProvider fonts={false}>
          {<PostItem post={{ ...parent, quotedPost: null }} isPostDetail={isPostDetail} />}
        </BloomThemeProvider>,
      ),
    );
    expect(text()).not.toContain('Quoted original');
    act(() => tree.unmount());
  },
);

it('aligns focused actions with the full-width text and keeps them before metadata', () => {
  let feed: TestRenderer.ReactTestRenderer | undefined;
  let detail: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    feed = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={postWith([owner])} />}
      </BloomThemeProvider>,
    );
    detail = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={postWith([owner])} isPostDetail />}
      </BloomThemeProvider>,
    );
  });
  if (!feed || !detail) throw new Error('Post render did not complete');
  const host = (tree: TestRenderer.ReactTestRenderer, name: string) =>
    tree.root.findAll((node) => typeof node.type === 'string' && node.type === name)[0];
  /** The host view a node is drawn in: its nearest host ancestor. */
  const hostAround = (node: TestRenderer.ReactTestInstance | undefined) => {
    let current = node?.parent ?? null;
    while (current && typeof current.type !== 'string') current = current.parent;
    return current;
  };
  /** The action bar's inset: the host view around the row's actions view. */
  const actionsInset = (tree: TestRenderer.ReactTestRenderer) =>
    StyleSheet.flatten(
      hostAround(
        tree.root.findAll(
          (node) => typeof node.props === 'object' && 'onInsightsPress' in node.props,
        )[0],
      )?.props.style,
    );
  // The feed row's actions start at the body column (64) and end 12pt in; the
  // focused post's span the row, inset as its full-width body is.
  expect(actionsInset(feed)).toEqual({ paddingStart: 64, paddingEnd: 12 });
  const body = StyleSheet.flatten(host(detail, 'PostContentText').parent?.props.style);
  expect(body).toMatchObject({ paddingStart: 12, paddingEnd: 12 });
  expect(actionsInset(detail)).toEqual({
    paddingStart: body.paddingStart,
    paddingEnd: body.paddingEnd,
  });
  // In document order: the actions, then the post's metadata.
  const order = detail.root.findAll(() => true);
  const actionsView = detail.root.findAll(
    (node) => typeof node.props === 'object' && 'onInsightsPress' in node.props,
  )[0];
  expect(order.indexOf(actionsView)).toBeLessThan(order.indexOf(host(detail, 'PostDetailStats')));
  act(() => {
    feed?.unmount();
    detail?.unmount();
  });
});

it('shows only the supplied social reason, updates recycled rows and opens the liked post', () => {
  const parent = postWith([owner]);
  const socialContext = {
    type: 'likedBy' as const,
    postId: parent.id,
    actors: [writer, owner],
    total: 4,
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={parent} socialContext={socialContext} />}
      </BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('Post render did not complete');
  const tree = renderer;
  const label = 'Liked by Nate Isern, Ana Torres and 2 others';
  const button = tree.root.findAll(
    (node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === label,
  )[0];
  expect(button).toBeDefined();
  const stopPropagation = jest.fn();
  act(() => button.props.onPress({ stopPropagation }));
  expect(stopPropagation).toHaveBeenCalledTimes(1);
  const dialog = mockDialogs[mockDialogs.length - 1];
  expect(dialog.label).toBe('Likes');
  expect(dialog.render(() => undefined).props.children?.props).toMatchObject({
    postId: parent.id,
    type: 'likes',
  });
  act(() =>
    tree.update(
      <BloomThemeProvider fonts={false}>
        {
          <PostItem
            post={parent}
            socialContext={{ ...socialContext, actors: [writer], total: 1 }}
          />
        }
      </BloomThemeProvider>,
    ),
  );
  expect(JSON.stringify(tree.toJSON())).toContain('Liked by Nate Isern');
  expect(JSON.stringify(tree.toJSON())).not.toContain('2 others');
  act(() =>
    tree.update(
      <BloomThemeProvider fonts={false}>{<PostItem post={parent} />}</BloomThemeProvider>,
    ),
  );
  expect(JSON.stringify(tree.toJSON())).not.toContain('Liked by');
  act(() => tree.unmount());
});

it('does not infer likes from counts or apply another post’s social context', () => {
  const parent = postWith([owner]);
  for (const context of [
    undefined,
    { type: 'likedBy' as const, postId: 'other-post', actors: [writer], total: 1 },
    { type: 'likedBy' as const, postId: parent.id, actors: [], total: 7 },
  ]) {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider fonts={false}>
          {<PostItem post={parent} socialContext={context} />}
        </BloomThemeProvider>,
      );
    });
    if (!renderer) throw new Error('Post render did not complete');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Liked by');
    act(() => renderer?.unmount());
  }
});

it('keeps quote commentary with a generic unavailable subject, then replaces the placeholder', () => {
  const parent = {
    ...postWith([owner]),
    quotedPostUnavailable: true,
    content: { text: 'My commentary' },
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>{<PostItem post={parent} />}</BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('Post render did not complete');
  const tree = renderer;
  expect(JSON.stringify(tree.toJSON())).toContain('My commentary');
  expect(JSON.stringify(tree.toJSON())).toContain('This quoted post is unavailable');
  act(() =>
    tree.update(
      <BloomThemeProvider fonts={false}>
        {
          <PostItem
            post={{
              ...parent,
              quotedPostUnavailable: undefined,
              quotedPost: { ...postWith([writer]), id: 'original' },
            }}
          />
        }
      </BloomThemeProvider>,
    ),
  );
  expect(JSON.stringify(tree.toJSON())).not.toContain('This quoted post is unavailable');
  act(() => tree.unmount());
});

it('opens repost evidence as reposts and does not repeat the same structural booster', () => {
  const parent = postWith([owner]);
  const context = { type: 'boostedBy' as const, postId: parent.id, actors: [writer], total: 1 };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={parent} socialContext={context} />}
      </BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('Post render did not complete');
  const tree = renderer;
  const button = tree.root.findAll(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'Reposted by Nate Isern',
  )[0];
  expect(button).toBeDefined();
  expect(JSON.stringify(tree.toJSON())).not.toContain('Liked by');
  act(() => button.props.onPress({ stopPropagation: jest.fn() }));
  const dialog = mockDialogs[mockDialogs.length - 1];
  expect(dialog.render(() => undefined).props.children?.props).toMatchObject({
    postId: parent.id,
    type: 'boosts',
  });
  act(() =>
    tree.update(
      <BloomThemeProvider fonts={false}>
        {<PostItem post={parent} repostedBy={writer} socialContext={context} />}
      </BloomThemeProvider>,
    ),
  );
  expect(
    tree.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityLabel === 'Reposted by Nate Isern',
    ),
  ).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('Reposted by');
  act(() => tree.unmount());
});

it.each([
  { detail: true, nested: false, owned: true, enabled: true },
  { detail: false, nested: false, owned: true, enabled: false },
  { detail: true, nested: true, owned: true, enabled: false },
  { detail: true, nested: false, owned: false, enabled: false },
])(
  'offers the direct Insights action only for the owned focused detail: %j',
  ({ detail, nested, owned, enabled }) => {
    const post = postWith([owner]);
    post.viewerState = { ...post.viewerState, isOwner: owned };
    const openPanel = jest.fn(() => true);
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider fonts={false}>
          {
            <PostItem
              post={post}
              isPostDetail={detail}
              isNested={nested}
              openPostEngagement={openPanel}
            />
          }
        </BloomThemeProvider>,
      );
    });
    if (!renderer) throw new Error('Post did not render');
    // The row's actions view, by the prop the Insights action rides on.
    const action = renderer.root.findAll(
      (node) => typeof node.props === 'object' && 'onInsightsPress' in node.props,
    )[0]?.props.onInsightsPress;
    if (enabled) {
      expect(action).toEqual(expect.any(Function));
      act(() => action());
      expect(openPanel).toHaveBeenCalledWith(post.id, 'insights');
    } else expect(action).toBeUndefined();
    act(() => renderer?.unmount());
  },
);
