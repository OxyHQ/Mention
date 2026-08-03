import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { PostVisibility } from '@mention/shared-types';
import type { HydratedAuthor, HydratedPost, PostUser } from '@mention/shared-types';

import PostItem from '../PostItem';

/**
 * `PostItem` decides two things about authorship that only it can see, and both
 * are invisible from `PostHeader`'s own tests:
 *
 *  1. WHICH HEADING the author dialog opens with. A signed channel post reaches
 *     the same panel as a collaboration, and only the byline roles distinguish
 *     them — `writer` exists on no other byline, so it, not the account kind, is
 *     what picks "Published by" over "Collaborators".
 *  2. THAT THE BOOSTER REACHES THE HEADER AT ALL. `PostHeader` pairs and
 *     reorders the avatar cluster from `boostedBy`; the prop sat declared and
 *     unpassed, so every one of those rules was dead code in the app while
 *     passing its own unit tests. This pins the wire, and pins that the id in it
 *     is the one `HydratedAuthor.id` is compared against — the two coming from
 *     different id spaces is the failure that reorders nothing, silently.
 */

interface CapturedHeaderProps {
  boostedBy?: PostUser;
  authors?: HydratedAuthor[];
  onPressCollaborators?: () => void;
}
const mockHeaderProps: CapturedHeaderProps[] = [];
jest.mock('../../Post/PostHeader', () => ({
  __esModule: true,
  default: (props: CapturedHeaderProps) => {
    mockHeaderProps.push(props);
    return null;
  },
  HEADER_CONTENT_GAP: 4,
  POST_CONTEXT_ROW_HEIGHT: 18,
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
jest.mock('@/components/common/ContentDialog', () => ({
  showContentDialog: (dialog: CapturedDialog) => {
    mockDialogs.push(dialog);
  },
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/',
}));

jest.mock('../../../stores/postsStore', () => ({ usePostSelector: () => undefined }));

jest.mock('@/stores/threadHoverStore', () => ({
  useThreadHoverStore: (selector: (state: unknown) => unknown) =>
    selector({ setHoveredSlice: () => undefined, hoveredSliceKey: null }),
}));

// The real `BottomSheetContext` is used — `useContext` needs a genuine context
// object and its defaults already no-op — so only the untransformed Bloom module
// it imports is stubbed. Nothing in these tests opens a bottom sheet.
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
jest.mock('../../Post/PostLanguageChip', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostLaneChip', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/ContentWarning', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostActions', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostDetailStats', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostLocation', () => ({ __esModule: true, default: () => null }));
jest.mock('../../Post/PostAttachmentsRow', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ProfileHoverCard', () => ({
  ProfileHoverCard: ({ children }: { children: React.ReactNode }) => children,
}));

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
    selectLanguage: () => undefined,
    toggleReaderTranslation: () => undefined,
  }),
}));

jest.mock('@/components/common/ActionMenu', () => ({ showActionMenu: () => undefined }));
jest.mock('@/utils/feedTelemetry', () => ({ reportFeedInteraction: () => undefined }));

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ?? null,
}));

// Resolves against the real `en.json` and ignores `defaultValue`: the headings
// are the assertion, so a deleted key must render its raw name and fail rather
// than fall back to a default that reads identically.
jest.mock('react-i18next', () => {
  const strings: Record<string, string> = require('@/locales/en.json');
  return { useTranslation: () => ({ t: (key: string) => strings[key] ?? key }) };
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

function render(element: React.ReactElement) {
  act(() => {
    TestRenderer.create(element);
  });
}

/** The props of the header this render produced. */
function lastHeader(): CapturedHeaderProps {
  return mockHeaderProps[mockHeaderProps.length - 1];
}

/**
 * Opens the author dialog the way the avatar cluster does. The element tree is
 * read rather than rendered: the panel is `lazy()`, so resolving it would only
 * re-assert the prop through another mock.
 */
function openAuthorDialog(): { label: string; panelTitle?: string } {
  act(() => {
    lastHeader().onPressCollaborators?.();
  });
  const dialog = mockDialogs[mockDialogs.length - 1];
  return {
    label: dialog.label,
    panelTitle: dialog.render(() => undefined).props.children?.props.title,
  };
}

describe('PostItem author dialog heading', () => {
  beforeEach(() => {
    mockHeaderProps.length = 0;
    mockDialogs.length = 0;
  });

  it('says "Published by" when the byline names a writer — nobody co-authored anything', () => {
    render(<PostItem post={postWith([channel, writer])} />);
    expect(openAuthorDialog()).toEqual({ label: 'Published by', panelTitle: 'Published by' });
  });

  it('says "Collaborators" for a genuine collaboration', () => {
    render(<PostItem post={postWith([owner, collaborator])} />);
    expect(openAuthorDialog()).toEqual({ label: 'Collaborators', panelTitle: 'Collaborators' });
  });

  it('does not open at all for a solo post', () => {
    render(<PostItem post={postWith([owner])} />);
    expect(lastHeader().onPressCollaborators).toBeUndefined();
  });
});

describe('PostItem boost wiring', () => {
  beforeEach(() => {
    mockHeaderProps.length = 0;
    mockDialogs.length = 0;
  });

  it('hands the header the BOOSTER, in the id space the authors carry', () => {
    // `feedRows` unwraps a boost into (original post, `repostedBy` = the boost
    // actor), and both that actor and every `authors[]` entry are the canonical
    // Oxy `PostUser` keyed by Oxy user id — so the header's `id` comparison
    // finds a match when there is one.
    render(<PostItem post={postWith([channel, writer])} repostedBy={writer} />);
    expect(lastHeader().boostedBy?.id).toBe(writer.id);
    expect(lastHeader().authors?.map((author) => author.id)).toContain(
      lastHeader().boostedBy?.id,
    );
  });

  it('hands over an outside booster too — the header decides what to do with them', () => {
    render(<PostItem post={postWith([owner])} repostedBy={boosterUser} />);
    expect(lastHeader().boostedBy?.id).toBe(boosterUser.id);
    expect(lastHeader().authors?.map((author) => author.id)).not.toContain(boosterUser.id);
  });

  it('leaves it unset when no boost surfaced the row', () => {
    render(<PostItem post={postWith([channel, writer])} />);
    expect(lastHeader().boostedBy).toBeUndefined();
  });
});
