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

describe('AccountBadge — the channel marker has no explainer to open', () => {
  it('ignores a handler for a channel while honouring the SAME handler when federated', () => {
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
 * that passes `onExplainNetwork` would leave all of them green — which is the
 * exact regression this whole change exists to prevent, so it is gated on the
 * source rather than remembered.
 */
describe('surfaces — only the profile opts the marker in', () => {
  const FRONTEND_ROOT = path.resolve(__dirname, '../..');
  const SCAN_ROOTS = ['app', 'components'];

  /**
   * Files permitted to mention `onExplainNetwork`, each for a stated reason.
   * Anything else naming it is a surface arming the marker.
   */
  const ALLOWED: Record<string, string> = {
    'components/AccountBadge.tsx': 'defines the opt-in',
    'components/Profile/types.ts': 'declares the prop on UserNameProps',
    'components/UserName.tsx': 'forwards its own prop through; opts nothing in itself',
    'components/ProfileScreen.tsx': 'THE opt-in — the profile is where the explainer belongs',
    'components/__tests__/AccountBadge.test.tsx': 'this test',
  };

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

  const files = SCAN_ROOTS.flatMap((root) => walk(path.join(FRONTEND_ROOT, root)));
  const sources = files.map((file) => ({
    rel: path.relative(FRONTEND_ROOT, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }));

  it('scanned a real tree (vacuity floor)', () => {
    // A broken traversal returns nothing and makes every assertion below pass.
    expect(sources.length).toBeGreaterThan(300);
    const rendering = sources.filter(({ text }) => /<AccountBadge[\s/>]/.test(text));
    expect(rendering.length).toBeGreaterThanOrEqual(4);
  });

  it('no surface other than the profile arms the marker', () => {
    const offenders = sources
      .filter(({ text }) => text.includes('onExplainNetwork'))
      .map(({ rel }) => rel)
      .filter((rel) => !(rel in ALLOWED));

    expect(offenders).toEqual([]);
  });

  it('every allow-listed file still names it, so the list cannot rot', () => {
    const named = new Set(
      sources.filter(({ text }) => text.includes('onExplainNetwork')).map(({ rel }) => rel),
    );
    expect(Object.keys(ALLOWED).filter((rel) => !named.has(rel))).toEqual([]);
  });
});
