import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { HydratedAuthor, PostUser } from '@mention/shared-types';

import PostHeader from '../PostHeader';

/**
 * The identity row every post is drawn with, and the three decisions it makes
 * that nothing else can catch when they break — each one renders a plausible,
 * confidently wrong row rather than an error:
 *
 *  1. WHICH NAME. A person contributes a FIRST name, because a collaborative
 *     byline is a sentence ("Ana and Luis"). A non-personal account has a TITLE
 *     and no `first`/`last`, so splitting it truncates: "Notas de Nate" became
 *     "Notas".
 *  2. WHICH SEPARATOR. `and` claims joint authorship. A channel naming its
 *     writer did not co-author anything with them, so it reads `by`.
 *  3. WHICH AVATARS, IN WHICH ORDER. The cluster answers "how did this row reach
 *     me", so an author who boosted it LEADS and a non-author who boosted it
 *     TRAILS — opposite ends, because one of them authored the post and the
 *     other did not.
 *
 * The two orderings in (3) are asserted against each other rather than against a
 * single expected array: an implementation that never reorders and one that
 * always reorders each satisfy exactly one of them, so both directions are
 * needed before either means anything.
 */

// Each of these is mocked to a HOST element name rather than a component, so the
// props the header computed survive into the rendered tree verbatim — the
// cluster's `items` order is read as the array the header built, not as a
// re-encoding of it — and none of them contributes text `collectText` would
// then have to filter back out.
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@/components/ui/LiveAvatar', () => ({ LiveAvatar: 'LiveAvatar' }));
jest.mock('@oxyhq/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('../../UserName', () => ({ __esModule: true, default: 'UserName' }));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#8899a6' } }),
}));

jest.mock('@/components/Fediverse/FediverseBadge', () => ({ RemoteActorBadge: () => null }));
jest.mock('@/assets/icons/boost-icon', () => ({ BoostIcon: () => null }));

/**
 * `t` resolves against the REAL `en.json` and deliberately IGNORES
 * `defaultValue`. The separator assertions are about which KEY the header
 * chooses, and every key here happens to have a default identical to its English
 * string — so honouring the default would let a deleted `collab.by` render " by "
 * anyway and pass. Ignoring it makes a missing key render the raw key and fail.
 */
jest.mock('react-i18next', () => {
  const strings: Record<string, string> = require('@/locales/en.json');
  return {
    useTranslation: () => ({ t: (key: string) => strings[key] ?? key }),
  };
});

// `@oxyhq/core` is not transformed in this suite. Mocked with the REAL rule so
// the federated `user@domain` handle path is genuinely exercised.
function mockHandlePart(value?: string | null): string | null {
  const trimmed = value?.trim().replace(/^@+/, '');
  if (!trimmed || /[/?#]/.test(trimmed)) return null;
  return trimmed;
}
function mockNormalizedHandle(user: {
  username?: string | null;
  instance?: string | null;
  isFederated?: boolean | null;
  federation?: { domain?: string | null } | null;
} | null | undefined): string | null {
  const username = mockHandlePart(user?.username);
  if (!username) return null;
  const instance = mockHandlePart(user?.instance ?? user?.federation?.domain);
  if (user?.isFederated === true && instance && !username.includes('@')) {
    return `${username}@${instance}`;
  }
  return username;
}
jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: unknown) =>
    mockNormalizedHandle(user as Parameters<typeof mockNormalizedHandle>[0]),
}));

// --- fixtures ---

/** The channel: a TITLE, no `first`/`last` — the shape `kind` exists to mark. */
const channel: HydratedAuthor = {
  id: 'acct-notas',
  username: 'notas',
  kind: 'channel',
  name: { displayName: 'Notas de Nate' },
  avatar: 'file-notas',
  role: 'owner',
  status: 'accepted',
};

/** The person the channel discloses. A `writer` exists on no other byline. */
const writer: HydratedAuthor = {
  id: 'acct-nate',
  username: 'nate',
  kind: 'personal',
  name: { displayName: 'Nate Isern' },
  avatar: 'file-nate',
  role: 'writer',
  status: 'accepted',
};

const collaborator = (id: string, username: string, displayName: string): HydratedAuthor => ({
  id,
  username,
  kind: 'personal',
  name: { displayName },
  avatar: `file-${username}`,
  role: 'collaborator',
  status: 'accepted',
});

const booster: PostUser = {
  id: 'acct-mar',
  username: 'mar',
  kind: 'personal',
  name: { displayName: 'Mar Ruiz' },
  avatar: 'file-mar',
};

// --- harness ---

type HeaderProps = React.ComponentProps<typeof PostHeader>;

function render(props: Partial<HeaderProps> = {}): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PostHeader
        user={{ displayName: 'Notas de Nate', handle: 'notas' }}
        onPressAuthor={jest.fn()}
        {...props}
      />,
    );
  });
  return renderer;
}

/** Every string the header rendered, in order. */
function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

/**
 * The collaborative byline's own `Text`, found by `numberOfLines={2}` — the only
 * two-line text in the header (the trailing `@handle` is one line). Returns null
 * for a solo identity line, which renders no byline at all.
 */
function bylineText(renderer: TestRenderer.ReactTestRenderer): string | null {
  const found = renderer.root.findAll(
    (node) => typeof node.type === 'string' && node.props?.numberOfLines === 2,
  );
  return found.length > 0 ? collectText(found[0]) : null;
}

/** Cluster member ids, in render order. Null when no cluster was rendered. */
function clusterIds(renderer: TestRenderer.ReactTestRenderer): string[] | null {
  const found = renderer.root.findAll((node) => String(node.type) === 'AvatarGroup');
  if (found.length === 0) return null;
  const items: { id?: string }[] = found[0].props.items ?? [];
  return items.map((item) => item.id ?? '?');
}

function hasSoloAvatar(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAll((node) => String(node.type) === 'LiveAvatar').length > 0;
}

/**
 * Every name the solo identity line rendered. An assertion that the byline did
 * not GROW needs this rather than a search of the rendered text: a booster
 * wrongly promoted into `headerAuthors` replaces the solo line entirely, so
 * "their name is absent from the tree" is true either way.
 */
function soloNames(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => String(node.type) === 'UserName')
    .map((node) => String(node.props.name ?? ''));
}

function clusterPressable(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance | null {
  const found = renderer.root.findAll(
    (node) => node.props?.accessibilityRole === 'button' && 'disabled' in (node.props ?? {}),
  );
  return found.length > 0 ? found[0] : null;
}

describe('PostHeader byline names', () => {
  it('keeps a non-personal account’s whole title while a person still gives a first name', () => {
    // BOTH halves in one row on purpose: an implementation that splits nothing
    // renders "Notas de Nate by Nate Isern", one that splits everything renders
    // "Notas by Nate". Only the mixed expectation rejects both.
    expect(bylineText(render({ authors: [channel, writer] }))).toBe('Notas de Nate by Nate');
  });

  it('splits a person’s display name even with no `name.first` to read', () => {
    const authors = [
      collaborator('acct-ana', 'ana', 'Ana Torres'),
      collaborator('acct-luis', 'luis', 'Luis Prado'),
    ];
    expect(bylineText(render({ authors }))).toBe('Ana and Luis');
  });

  it('treats an author with NO `kind` as a person', () => {
    // The shape that tells `kind === undefined || kind === 'personal'` from a
    // bare `kind === 'personal'`: a degraded or federated author summary carries
    // no `kind` at all, and reading its absence as "not a person" would stop
    // splitting every one of them. Every other fixture here states a `kind`, so
    // without this one both readings pass.
    const authors: HydratedAuthor[] = [
      { ...collaborator('acct-ana', 'ana', 'Ana Torres'), kind: undefined },
      { ...collaborator('acct-luis', 'luis', 'Luis Prado'), kind: undefined },
    ];
    expect(bylineText(render({ authors }))).toBe('Ana and Luis');
  });

  it('prefers the structured `name.first` for a person', () => {
    const authors: HydratedAuthor[] = [
      { ...collaborator('acct-ana', 'ana', 'Ana Torres'), name: { displayName: 'Ana Torres', first: 'Anabel' } },
      collaborator('acct-luis', 'luis', 'Luis Prado'),
    ];
    expect(bylineText(render({ authors }))).toBe('Anabel and Luis');
  });

  it('ignores `name.first` for a non-personal account, whose title is the name', () => {
    // A channel with a stray `first` is exactly the case where reading the
    // structured field first would resurrect the truncation this rule removed.
    const titled: HydratedAuthor = {
      ...channel,
      name: { displayName: 'Notas de Nate', first: 'Notas' },
    };
    expect(bylineText(render({ authors: [titled, writer] }))).toBe('Notas de Nate by Nate');
  });

  it('falls back to the normalized @handle — never a raw id — when there is no name', () => {
    const nameless: HydratedAuthor = { ...channel, name: {} };
    const federated: HydratedAuthor = {
      ...collaborator('acct-remote', 'remote', ''),
      name: {},
      isFederated: true,
      instance: 'mastodon.social',
      role: 'writer',
    };
    expect(bylineText(render({ authors: [nameless, federated] }))).toBe(
      '@notas by @remote@mastodon.social',
    );
  });

  it('contributes NOTHING for an author with neither a name nor a handle', () => {
    // The ghost-handle rule: a degraded author renders an empty handle, so there
    // is no last resort to fall back to and the raw id must not become one. Two
    // things the fixtures have to get right, and each was wrong first. The
    // fixture must actually LACK a handle — with one, every fallback order
    // produces the same string and the assertion cannot fail. And it must run on
    // BOTH sides of the person split, because each branch spells its own last
    // resort and a fixture on one side cannot see the other's.
    const ghost = (kind: HydratedAuthor['kind']): HydratedAuthor => ({
      id: `acct-ghost-${kind}`,
      username: '',
      kind,
      name: {},
      role: 'collaborator',
      status: 'accepted',
    });
    const luis = collaborator('acct-luis', 'luis', 'Luis Prado');

    for (const kind of ['personal', 'channel'] as const) {
      const text = bylineText(render({ authors: [ghost(kind), luis] }));
      expect(text).toBe(' and Luis');
      expect(text).not.toContain('acct-ghost');
    }
  });
});

describe('PostHeader byline separator', () => {
  it('reads `by` when the byline names a writer', () => {
    expect(bylineText(render({ authors: [channel, writer] }))).toContain(' by ');
  });

  it('reads `and` when it does not — nobody is a writer', () => {
    const authors = [
      collaborator('acct-ana', 'ana', 'Ana Torres'),
      collaborator('acct-luis', 'luis', 'Luis Prado'),
    ];
    const text = bylineText(render({ authors }));
    expect(text).toContain(' and ');
    expect(text).not.toContain(' by ');
  });

  it('keeps commas before the final separator for three collaborators', () => {
    const authors = [
      collaborator('acct-ana', 'ana', 'Ana Torres'),
      collaborator('acct-luis', 'luis', 'Luis Prado'),
      collaborator('acct-eva', 'eva', 'Eva Sanz'),
    ];
    expect(bylineText(render({ authors }))).toBe('Ana, Luis and Eva');
  });
});

describe('PostHeader avatar cluster order', () => {
  it('leads with the channel when nothing boosted the row', () => {
    expect(clusterIds(render({ authors: [channel, writer] }))).toEqual([channel.id, writer.id]);
  });

  it('leads with the WRITER when the writer’s boost surfaced the row', () => {
    // The opposite of the previous case, from the same authors — which is what
    // makes either assertion mean anything.
    expect(clusterIds(render({ authors: [channel, writer], boostedBy: writer }))).toEqual([
      writer.id,
      channel.id,
    ]);
  });

  it('leaves the order alone when the CHANNEL’s own boost surfaced the row', () => {
    expect(clusterIds(render({ authors: [channel, writer], boostedBy: channel }))).toEqual([
      channel.id,
      writer.id,
    ]);
  });

  it('never reorders the NAMES, whichever avatar leads', () => {
    const led = render({ authors: [channel, writer], boostedBy: writer });
    expect(bylineText(led)).toBe('Notas de Nate by Nate');
  });
});

describe('PostHeader ordinary repost', () => {
  const soloAuthor = collaborator('acct-ana', 'ana', 'Ana Torres');
  const soloUser: HeaderProps['user'] = { displayName: 'Ana Torres', handle: 'ana' };

  it('pairs the author with the booster — author first, booster second', () => {
    const renderer = render({ user: soloUser, authors: [soloAuthor], boostedBy: booster });
    // Opposite end from the channel case above: the booster authored nothing, so
    // the second avatar is attribution rather than a byline entry.
    expect(clusterIds(renderer)).toEqual([soloAuthor.id, booster.id]);
  });

  it('names ONLY the author — the pair is not a collaborative byline', () => {
    const renderer = render({ user: soloUser, authors: [soloAuthor], boostedBy: booster });
    expect(bylineText(renderer)).toBeNull();
    expect(soloNames(renderer)).toEqual(['Ana Torres']);
  });

  it('keeps a single avatar when no boost surfaced the row', () => {
    const renderer = render({ user: soloUser, authors: [soloAuthor] });
    expect(clusterIds(renderer)).toBeNull();
    expect(hasSoloAvatar(renderer)).toBe(true);
  });

  it('does not pair when the booster is the author themselves', () => {
    const renderer = render({ user: soloUser, authors: [soloAuthor], boostedBy: soloAuthor });
    expect(clusterIds(renderer)).toBeNull();
    expect(hasSoloAvatar(renderer)).toBe(true);
  });

  it('leaves a COLLABORATIVE cluster alone when an outsider boosted it', () => {
    // The cluster there is the byline made visual and its tap lists exactly
    // those authors, so a third avatar would have no row to open.
    const authors = [
      collaborator('acct-ana', 'ana', 'Ana Torres'),
      collaborator('acct-luis', 'luis', 'Luis Prado'),
    ];
    expect(clusterIds(render({ authors, boostedBy: booster }))).toEqual([
      'acct-ana',
      'acct-luis',
    ]);
  });

  it('keeps the solo avatar when there are no authors to pair the booster with', () => {
    // An orphan federated post carries no `authors[]`, so there is no
    // author-shaped record to put beside the booster.
    const renderer = render({ user: soloUser, boostedBy: booster });
    expect(clusterIds(renderer)).toBeNull();
    expect(hasSoloAvatar(renderer)).toBe(true);
  });
});

describe('PostHeader cluster press target', () => {
  it('opens the author list for a collaborative byline', () => {
    const onPressCollaborators = jest.fn();
    const onPressAvatar = jest.fn();
    const renderer = render({
      authors: [channel, writer],
      onPressCollaborators,
      onPressAvatar,
    });

    act(() => {
      clusterPressable(renderer)?.props.onPress();
    });

    expect(onPressCollaborators).toHaveBeenCalledTimes(1);
    expect(onPressAvatar).not.toHaveBeenCalled();
  });

  it('opens the author’s own profile for an attribution pair — there is one author', () => {
    const onPressCollaborators = jest.fn();
    const onPressAvatar = jest.fn();
    const renderer = render({
      user: { displayName: 'Ana Torres', handle: 'ana' },
      authors: [collaborator('acct-ana', 'ana', 'Ana Torres')],
      boostedBy: booster,
      onPressCollaborators,
      onPressAvatar,
    });

    act(() => {
      clusterPressable(renderer)?.props.onPress();
    });

    expect(onPressAvatar).toHaveBeenCalledTimes(1);
    expect(onPressCollaborators).not.toHaveBeenCalled();
  });
});
