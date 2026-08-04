import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AccountBadge, FediverseSharingBadge } from '../AccountBadge';
import enStrings from '@/locales/en.json';

/**
 * The identity marker beside a name, and the two rules that decide what it does.
 *
 * Both rules fail SILENTLY when they break — a wrong marker is a plausible
 * marker, and an over-eager one just swallows a tap — so each is asserted from
 * BOTH sides. The shape that makes these tests worth anything:
 *
 *  - "inert" is indistinguishable from "did not render" unless the same test
 *    also proves the marker IS on screen. Every inertness assertion below is
 *    therefore paired with a positive one; drop the pair and the test passes
 *    against a component that returns `null` for everything.
 *  - "channels get a marker" is indistinguishable from "everybody gets a marker"
 *    unless a NON-channel fixture asserts nothing renders. Both are here.
 *  - "the channel marker ignores a handler" is indistinguishable from "the
 *    handler prop is broken" unless the same test shows the identical handler
 *    DOES arm the federated marker. That contrast is inside the test.
 */

// Host-string mocks: the marker each branch chose survives into the tree as a
// distinguishable element, so "which icon" is read off the render rather than
// re-derived from the props the test just passed in.
jest.mock('@/assets/icons/fediverse-icon', () => ({ FediverseIcon: 'FediverseIcon' }));
jest.mock('@/assets/icons/channel-icon', () => ({ ChannelIcon: 'ChannelIcon' }));

/**
 * `t` resolves against the REAL `en.json`, walking dotted paths through both the
 * flat keys and the nested objects the catalog mixes. An unknown key returns a
 * marker string rather than the key itself, so a label asserted below can never
 * be satisfied by a key that was never added to the catalog.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const catalog: Record<string, unknown> = require('@/locales/en.json');
      if (typeof catalog[key] === 'string') return catalog[key];
      const resolved = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object'
              ? (node as Record<string, unknown>)[part]
              : undefined,
          catalog,
        );
      return typeof resolved === 'string' ? resolved : `MISSING_I18N_KEY:${key}`;
    },
  }),
}));

const CHANNEL_LABEL = enStrings.channels.badge.a11yLabel;
const REMOTE_LABEL = enStrings['fediverse.remoteBadge.a11yLabel'];
const SHARING_LABEL = enStrings['fediverse.badge.a11yLabel'];

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/**
 * HOST nodes only. A `Pressable` appears several times on the way down (the
 * composite element, its inner wrappers, the host `View` it finally becomes),
 * all carrying the same props — counting every one of them turns "exactly one
 * control" into an arbitrary number that says nothing.
 */
function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

/** Every rendered element that claims to be an activatable control. */
function buttons(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => isHost(node) && node.props?.accessibilityRole === 'button',
    { deep: true },
  );
}

/**
 * The DISTINCT press handlers anywhere in the tree, composite nodes included.
 *
 * Host-only would be vacuous here and was: `Pressable` drives its host `View`
 * through the responder props, so the host carries no `onPress` even when the
 * badge is fully armed — a host-only count reads 0 for inert AND armed, and
 * cannot tell them apart. De-duplicating by function identity is what makes 0
 * and 1 mean what they say.
 */
function pressHandlers(renderer: ReactTestRenderer): ((event?: unknown) => void)[] {
  const unique = new Set<(event?: unknown) => void>();
  renderer.root
    .findAll((node) => typeof node.props?.onPress === 'function', { deep: true })
    .forEach((node) => unique.add(node.props.onPress));
  return [...unique];
}

function icons(renderer: ReactTestRenderer, hostName: string): ReactTestInstance[] {
  return renderer.root.findAllByType(hostName as unknown as React.ElementType);
}

/** The accessibility labels the marker exposed, in render order. */
function labels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => isHost(node) && typeof node.props?.accessibilityLabel === 'string', {
      deep: true,
    })
    .map((node) => String(node.props.accessibilityLabel));
}

describe('AccountBadge — a marker is a statement, not a control', () => {
  it('renders the federated marker as a plain icon that cannot be tapped', () => {
    const renderer = render(<AccountBadge isFederated />);

    // NON-VACUITY CONTROL. Without this the two assertions below are also
    // satisfied by a component that rendered nothing at all, which is the one
    // regression they exist to distinguish "inert" from.
    expect(icons(renderer, 'FediverseIcon')).toHaveLength(1);
    expect(labels(renderer)).toContain(REMOTE_LABEL);

    expect(buttons(renderer)).toHaveLength(0);
    expect(pressHandlers(renderer)).toHaveLength(0);
  });

  it('becomes a control ONLY when a caller opts in, and then it calls back', () => {
    const onExplainNetwork = jest.fn();
    const renderer = render(<AccountBadge isFederated onExplainNetwork={onExplainNetwork} />);

    const armed = buttons(renderer);
    expect(armed).toHaveLength(1);
    expect(armed[0].props.accessibilityLabel).toBe(REMOTE_LABEL);

    const handlers = pressHandlers(renderer);
    expect(handlers).toHaveLength(1);
    TestRenderer.act(() => {
      handlers[0]();
    });
    expect(onExplainNetwork).toHaveBeenCalledTimes(1);
  });

  it('keeps an opted-in tap to itself so an enclosing row does not also fire', () => {
    const onExplainNetwork = jest.fn();
    const renderer = render(<AccountBadge isFederated onExplainNetwork={onExplainNetwork} />);
    const stopPropagation = jest.fn();

    TestRenderer.act(() => {
      pressHandlers(renderer)[0]({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onExplainNetwork).toHaveBeenCalledTimes(1);
  });
});

describe('AccountBadge — which marker the account state chooses', () => {
  it('draws the channel marker for a channel account', () => {
    const renderer = render(<AccountBadge kind="channel" />);

    expect(icons(renderer, 'ChannelIcon')).toHaveLength(1);
    expect(icons(renderer, 'FediverseIcon')).toHaveLength(0);
    expect(labels(renderer)).toContain(CHANNEL_LABEL);
  });

  // The two fixtures that stop the test above from also passing for a component
  // that hands a marker to EVERY account.
  it.each(['personal', 'organization', 'project', 'bot'] as const)(
    'draws nothing at all for a local %s account',
    (kind) => {
      const renderer = render(<AccountBadge kind={kind} />);

      expect(renderer.toJSON()).toBeNull();
      expect(icons(renderer, 'ChannelIcon')).toHaveLength(0);
      expect(icons(renderer, 'FediverseIcon')).toHaveLength(0);
    },
  );

  it('draws nothing when the account state says nothing', () => {
    expect(render(<AccountBadge />).toJSON()).toBeNull();
    expect(render(<AccountBadge isFederated={false} kind={undefined} />).toJSON()).toBeNull();
  });

  it('draws the fediverse marker — and ONLY it — for a channel that is also federated', () => {
    const renderer = render(<AccountBadge kind="channel" isFederated />);

    // Exactly one marker, and it is the federated one. Asserting the channel
    // icon's ABSENCE is the half that catches a version stacking both.
    expect(icons(renderer, 'FediverseIcon')).toHaveLength(1);
    expect(icons(renderer, 'ChannelIcon')).toHaveLength(0);
    expect(labels(renderer)).toEqual([REMOTE_LABEL]);
  });

  it('names Bluesky rather than claiming it is the fediverse, and stays inert', () => {
    const onExplainNetwork = jest.fn();
    const renderer = render(
      <AccountBadge isFederated network="atproto" onExplainNetwork={onExplainNetwork} />,
    );

    expect(renderer.root.findAllByType('Text' as unknown as React.ElementType)).not.toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Bluesky');
    expect(icons(renderer, 'FediverseIcon')).toHaveLength(0);
    expect(buttons(renderer)).toHaveLength(0);
    expect(pressHandlers(renderer)).toHaveLength(0);
  });
});

/**
 * The two explainers are two PROPS, and each branch reads exactly one of them.
 *
 * A single shared handler would be the same component with the same call sites
 * and one new defect available: a surface that wanted the channel explainer
 * would arm the fediverse one on every remote account it draws, and vice versa.
 * Neither miswiring is visible in a render — both produce a tappable marker that
 * opens A dialog — so each direction is asserted here, and each assertion is
 * paired with the handler that IS honoured, or "ignored the handler" would be
 * indistinguishable from "the prop does not work at all".
 */
describe('AccountBadge — the two explainers cannot be crossed', () => {
  it('gives the channel marker the fediverse handler and nothing happens', () => {
    const onExplainNetwork = jest.fn();

    const channel = render(<AccountBadge kind="channel" onExplainNetwork={onExplainNetwork} />);
    // Positive control: the marker is on screen, it simply is not a control.
    expect(icons(channel, 'ChannelIcon')).toHaveLength(1);
    expect(buttons(channel)).toHaveLength(0);
    expect(pressHandlers(channel)).toHaveLength(0);

    // CONTRAST, same handler object: proves the assertions above are about the
    // channel branch and not about a handler prop that never worked.
    const federated = render(<AccountBadge isFederated onExplainNetwork={onExplainNetwork} />);
    expect(buttons(federated)).toHaveLength(1);
  });

  it('gives the federated marker the channel handler and nothing happens', () => {
    const onExplainChannel = jest.fn();

    const federated = render(<AccountBadge isFederated onExplainChannel={onExplainChannel} />);
    expect(icons(federated, 'FediverseIcon')).toHaveLength(1);
    expect(buttons(federated)).toHaveLength(0);
    expect(pressHandlers(federated)).toHaveLength(0);

    const channel = render(<AccountBadge kind="channel" onExplainChannel={onExplainChannel} />);
    expect(buttons(channel)).toHaveLength(1);
  });
});

describe('AccountBadge — the channel marker opts in on its own prop', () => {
  it('stays a plain icon with no handler', () => {
    const renderer = render(<AccountBadge kind="channel" />);

    expect(icons(renderer, 'ChannelIcon')).toHaveLength(1);
    expect(labels(renderer)).toContain(CHANNEL_LABEL);
    expect(buttons(renderer)).toHaveLength(0);
    expect(pressHandlers(renderer)).toHaveLength(0);
  });

  it('becomes a control when a caller opts in, and then it calls back', () => {
    const onExplainChannel = jest.fn();
    const renderer = render(<AccountBadge kind="channel" onExplainChannel={onExplainChannel} />);

    const armed = buttons(renderer);
    expect(armed).toHaveLength(1);
    expect(armed[0].props.accessibilityLabel).toBe(CHANNEL_LABEL);

    const handlers = pressHandlers(renderer);
    expect(handlers).toHaveLength(1);
    TestRenderer.act(() => {
      handlers[0]();
    });
    expect(onExplainChannel).toHaveBeenCalledTimes(1);
  });

  it('keeps an opted-in tap to itself so an enclosing row does not also fire', () => {
    const onExplainChannel = jest.fn();
    const renderer = render(<AccountBadge kind="channel" onExplainChannel={onExplainChannel} />);
    const stopPropagation = jest.fn();

    TestRenderer.act(() => {
      pressHandlers(renderer)[0]({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onExplainChannel).toHaveBeenCalledTimes(1);
  });

  it('draws a channel that is also federated as the inert remote marker, armed or not', () => {
    // The federation-wins rule and the opt-in are independent, and a reader
    // could reasonably expect arming the channel handler to force the channel
    // branch. It does not: which marker is drawn is decided by the account, and
    // only then does that marker look for its own handler.
    const onExplainChannel = jest.fn();
    const renderer = render(
      <AccountBadge kind="channel" isFederated onExplainChannel={onExplainChannel} />,
    );

    expect(icons(renderer, 'FediverseIcon')).toHaveLength(1);
    expect(icons(renderer, 'ChannelIcon')).toHaveLength(0);
    expect(buttons(renderer)).toHaveLength(0);
  });
});

describe('FediverseSharingBadge — the own-profile marker obeys the same default', () => {
  it('is inert with no handler and armed with one', () => {
    const inert = render(<FediverseSharingBadge />);
    expect(icons(inert, 'FediverseIcon')).toHaveLength(1);
    expect(labels(inert)).toContain(SHARING_LABEL);
    expect(buttons(inert)).toHaveLength(0);

    const onExplainNetwork = jest.fn();
    const armed = render(<FediverseSharingBadge onExplainNetwork={onExplainNetwork} />);
    expect(buttons(armed)).toHaveLength(1);
    TestRenderer.act(() => {
      pressHandlers(armed)[0]();
    });
    expect(onExplainNetwork).toHaveBeenCalledTimes(1);
  });
});

/**
 * The rule the unit tests above cannot hold on their own: they prove the DEFAULT
 * is inert, not that every surface actually takes it. A screen added next year
 * that passes either handler would leave all of them green — which is the exact
 * regression this whole change exists to prevent, so it is gated on the source
 * rather than remembered.
 *
 * ONE walk feeds both gates. Two copies of this scan is two places for the
 * traversal, the roots and the vacuity floor to drift, and the second copy is
 * the one that quietly stops scanning anything.
 */
const FRONTEND_ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = ['app', 'components'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const sources = SCAN_ROOTS.flatMap((root) => walk(path.join(FRONTEND_ROOT, root))).map((file) => ({
  rel: path.relative(FRONTEND_ROOT, file).split(path.sep).join('/'),
  text: fs.readFileSync(file, 'utf8'),
}));

/** Every scanned file that writes the handler's name down, for any reason. */
function filesNaming(handler: string): string[] {
  return sources.filter(({ text }) => text.includes(handler)).map(({ rel }) => rel);
}

describe('surfaces — the scan itself', () => {
  it('scanned a real tree (vacuity floor)', () => {
    // A broken traversal returns nothing and makes every assertion below pass.
    expect(sources.length).toBeGreaterThan(300);
    const rendering = sources.filter(({ text }) => /<AccountBadge[\s/>]/.test(text));
    expect(rendering.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * The gates below are allow-lists, so they can only ever catch a NEW file.
   * These two name the surfaces that draw a marker today and must keep taking
   * the default — without them, "armed on one page" and "armed everywhere" are
   * the same green run, since an allow-list says nothing about a file it does
   * not contain until that file breaks the rule.
   */
  it.each([
    ['components/Post/PostHeader.tsx', 'a post row is already a tap that opens the post'],
    ['components/ProfileHoverCard/index.web.tsx', 'a hover card is already a link to the profile'],
    ['components/notifications/NotificationItem.tsx', 'a notification row navigates on tap'],
  ])('leaves the marker inert in %s (%s)', (rel) => {
    const source = sources.find((entry) => entry.rel === rel);
    // Not `?.text` — a renamed file must fail loudly rather than pass by absence.
    expect(source).toBeDefined();
    expect(source?.text).toMatch(/<AccountBadge[\s/>]/);
    expect(source?.text).not.toContain('onExplainNetwork');
    expect(source?.text).not.toContain('onExplainChannel');
  });
});

describe('surfaces — only the profile arms the FEDIVERSE marker', () => {
  /**
   * Files permitted to mention `onExplainNetwork`, each for a stated reason.
   * Anything else naming it is a surface arming the marker.
   */
  const ALLOWED: Record<string, string> = {
    'components/AccountBadge.tsx': 'defines the opt-in',
    'components/Profile/types.ts': 'declares the prop on UserNameProps',
    'components/UserName.tsx': 'forwards its own prop through; opts nothing in itself',
    'components/Profile/hooks/usePersonProfileView.tsx':
      'THE opt-in — the profile is where the explainer belongs, and this hook builds its identity block for both platforms',
    'components/__tests__/AccountBadge.test.tsx': 'this test',
  };

  it('no surface other than the profile arms it', () => {
    expect(filesNaming('onExplainNetwork').filter((rel) => !(rel in ALLOWED))).toEqual([]);
  });

  it('every allow-listed file still names it, so the list cannot rot', () => {
    const named = new Set(filesNaming('onExplainNetwork'));
    expect(Object.keys(ALLOWED).filter((rel) => !named.has(rel))).toEqual([]);
  });

  it('the opt-in reaches the badge rather than only being mentioned', () => {
    // The rot check above is satisfied by a comment. This one is not.
    const profile = sources.find(
      (entry) => entry.rel === 'components/Profile/hooks/usePersonProfileView.tsx',
    );
    expect(profile?.text).toMatch(/onExplainNetwork=\{/);
  });
});

describe('surfaces — only a channel’s own page arms the CHANNEL marker', () => {
  /**
   * The same rule for the second explainer, kept as its own allow-list rather
   * than merged with the one above: the point of two props is that the two
   * permissions are different, and one shared list would let a file arm either
   * explainer once it was on it for one of them.
   */
  const ALLOWED: Record<string, string> = {
    'components/AccountBadge.tsx': 'defines the opt-in',
    'components/Profile/types.ts': 'declares the prop on UserNameProps',
    'components/UserName.tsx': 'forwards its own prop through; opts nothing in itself',
    'components/Profile/ChannelHeader.tsx':
      "THE opt-in — a channel's own page is where the explainer belongs",
    'components/__tests__/AccountBadge.test.tsx': 'this test',
  };

  it('no surface other than the channel header arms it', () => {
    expect(filesNaming('onExplainChannel').filter((rel) => !(rel in ALLOWED))).toEqual([]);
  });

  it('every allow-listed file still names it, so the list cannot rot', () => {
    const named = new Set(filesNaming('onExplainChannel'));
    expect(Object.keys(ALLOWED).filter((rel) => !named.has(rel))).toEqual([]);
  });

  it('the opt-in reaches the badge rather than only being mentioned', () => {
    const header = sources.find((entry) => entry.rel === 'components/Profile/ChannelHeader.tsx');
    expect(header?.text).toMatch(/onExplainChannel=\{/);
  });

  it('is the only file outside the badge that opens the dialog', () => {
    // `onExplainChannel` is the prop; `showChannelInfo` is the effect. A screen
    // could skip the prop entirely and call the dialog from an onPress of its
    // own, which the allow-list above would never see. Tests are excluded — one
    // has to name it to spy on it, and this file names it on the line below.
    const callers = sources
      .filter(({ rel }) => !rel.includes('__tests__'))
      .filter(({ text }) => text.includes('showChannelInfo'))
      .map(({ rel }) => rel);
    expect(callers.sort()).toEqual([
      'components/Channels/ChannelInfoDialog.tsx',
      'components/Profile/ChannelHeader.tsx',
    ]);
  });
});
