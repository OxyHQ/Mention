import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/**
 * The channel explainer, and the one property that fails catastrophically and
 * silently: the host is mounted at app BOOT, so it must render nothing — and in
 * particular must not reach `useTranslation` — until something asks for it.
 * Under react-i18next's default `useSuspense: true` that hook throws a promise
 * while i18n is initializing, which discards the root render, so the init effect
 * never commits and the app deadlocks on a blank screen with no console output.
 * This app has shipped that exact white screen before.
 *
 * A test cannot see a deadlock, so it is pinned from the observable side: the
 * translator is a spy, and mounting the host must not call it. Mutating the host
 * to render its content unconditionally turns that assertion red.
 */

const mockTranslate = jest.fn((key: string) => {
  const catalog: Record<string, unknown> = require('@/locales/en.json');
  const resolved = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog,
    );
  return typeof resolved === 'string' ? resolved : `MISSING_I18N_KEY:${key}`;
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => mockTranslate(key) }),
}));

jest.mock('@/assets/icons/channel-icon', () => ({ ChannelIcon: 'ChannelIcon' }));

/**
 * Both aliases carry a `Mock` prefix because a `jest.mock` factory may not
 * reference an out-of-scope name — and babel's hoist guard applies that to a
 * TYPE annotation too, so a plainly-named `Control` fails the suite at load with
 * "Invalid variable access", not at a line anyone would suspect. The prefix is
 * the documented escape hatch and is case-insensitive.
 */
type MockDialogControl = { open: () => void; close: () => void };
type MockNode = React.ReactNode;

/**
 * Bloom's `Dialog` reduced to the contract this component actually uses: it
 * renders its children, and `control.close()` reaches the `onClose` the caller
 * passed. Registration happens in an effect, which is also what makes the
 * component's own "open on mount" assumption meaningful here.
 */
jest.mock('@oxyhq/bloom/dialog', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const closers = new Map<MockDialogControl, () => void>();

  return {
    __esModule: true,
    useDialogControl: (): MockDialogControl =>
      ReactActual.useMemo<MockDialogControl>(() => {
        const control: MockDialogControl = {
          open: () => {},
          close: () => closers.get(control)?.(),
        };
        return control;
      }, []),
    Dialog: ({
      control,
      onClose,
      children,
    }: {
      control: MockDialogControl;
      onClose: () => void;
      children: MockNode;
    }) => {
      ReactActual.useEffect(() => {
        closers.set(control, onClose);
        return () => {
          closers.delete(control);
        };
      }, [control, onClose]);
      return children;
    },
  };
});

jest.mock('@oxyhq/bloom/button', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({ children, onPress }: { children: MockNode; onPress: () => void }) =>
      ReactActual.createElement(
        Pressable,
        { onPress, accessibilityRole: 'button' },
        ReactActual.createElement(Text, null, children),
      ),
  };
});

// eslint-disable-next-line import/first
import { ChannelInfoDialogProvider, showChannelInfo } from '../ChannelInfoDialog';
// eslint-disable-next-line import/first
import enStrings from '@/locales/en.json';

const COPY = enStrings.channels.explainer;

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(<ChannelInfoDialogProvider />);
  });
  return renderer;
}

/** Every string the render put on screen. */
function textOf(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON() ?? null);
}

/**
 * The rendered text of a subtree. Reading `props.children` instead would work
 * for a button whose child is a bare string and throw "circular structure" for
 * one whose child is an element — which is the same button one render later.
 */
function textIn(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textIn).join('');
}

/**
 * Presses the button showing `label`.
 *
 * `Pressable` drives its host through the responder props, so the host View
 * carries no `onPress` — the handler lives on the composite, which is why this
 * looks for a press handler anywhere rather than for the button host.
 */
function press(renderer: ReactTestRenderer, label: string): void {
  const button = renderer.root
    .findAll((node) => typeof node.props?.onPress === 'function', { deep: true })
    .find((node) => textIn(node).includes(label));
  if (!button) throw new Error(`no button labelled "${label}" on screen`);
  TestRenderer.act(() => {
    button.props.onPress();
  });
}

/** Unmounting commits the host's cleanup, so it belongs inside `act` like any update. */
function unmount(renderer: ReactTestRenderer): void {
  TestRenderer.act(() => {
    renderer.unmount();
  });
}

beforeEach(() => {
  mockTranslate.mockClear();
});

describe('the host is inert until something asks for the explainer', () => {
  it('renders nothing and translates nothing when mounted at boot', () => {
    const renderer = mount();

    expect(renderer.toJSON()).toBeNull();
    expect(mockTranslate).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('does nothing at all when nothing has mounted the host', () => {
    // The imperative entry point is a module-level slot. Calling it with no host
    // must be a no-op rather than a throw, because a deep link can land on a
    // screen before the providers tree has finished mounting.
    expect(() => showChannelInfo()).not.toThrow();
  });
});

describe('the explainer opens, steps and closes', () => {
  it('walks all three cards forward and back, then dismisses', () => {
    const renderer = mount();

    TestRenderer.act(() => {
      showChannelInfo();
    });

    expect(textOf(renderer)).toContain(COPY.step1.title);
    expect(textOf(renderer)).toContain(COPY.step1.body);

    press(renderer, COPY.next);
    expect(textOf(renderer)).toContain(COPY.step2.title);
    press(renderer, COPY.next);
    expect(textOf(renderer)).toContain(COPY.step3.title);

    // Last card swaps the primary label rather than offering a fourth step.
    expect(textOf(renderer)).toContain(COPY.done);
    expect(textOf(renderer)).not.toContain(COPY.next);

    press(renderer, COPY.back);
    expect(textOf(renderer)).toContain(COPY.step2.title);
    press(renderer, COPY.back);
    expect(textOf(renderer)).toContain(COPY.step1.title);

    // First card offers a dismissal, not a fourth direction.
    expect(textOf(renderer)).toContain(COPY.cancel);
    expect(textOf(renderer)).not.toContain(COPY.back);

    press(renderer, COPY.cancel);
    expect(renderer.toJSON()).toBeNull();

    unmount(renderer);
  });

  it('closes from the last card and can be opened again from the start', () => {
    const renderer = mount();

    TestRenderer.act(() => {
      showChannelInfo();
    });
    press(renderer, COPY.next);
    press(renderer, COPY.next);
    press(renderer, COPY.done);
    expect(renderer.toJSON()).toBeNull();

    TestRenderer.act(() => {
      showChannelInfo();
    });
    // Reopening on card three would be the state surviving the unmount.
    expect(textOf(renderer)).toContain(COPY.step1.title);

    unmount(renderer);
  });

  it('renders real copy rather than missing keys', () => {
    const renderer = mount();
    TestRenderer.act(() => {
      showChannelInfo();
    });

    expect(textOf(renderer)).not.toContain('MISSING_I18N_KEY');

    unmount(renderer);
  });

  /**
   * BOTH controls on ONE line.
   *
   * Stacked, the card grows tall enough on a phone to push the copy it is
   * explaining off the top of the sheet, and the second button lands under the
   * thumb that just pressed the first. The className is what is asserted because
   * it is what decides this: `react-native-css` emits real CSS on web and a
   * runtime style on native, so there is no single computed value both platforms
   * expose to a renderer test. The width behaviour that className produces is
   * verified in a real browser instead, at the narrowest supported viewport and
   * in the language with the longest labels.
   */
  it('puts both buttons on one row, each taking half of it', () => {
    const renderer = mount();
    TestRenderer.act(() => {
      showChannelInfo();
    });

    const rows = renderer.root.findAll(
      (node) =>
        typeof node.props?.className === 'string' &&
        node.props.className.includes('flex-row') &&
        textIn(node).includes(COPY.next) &&
        textIn(node).includes(COPY.cancel),
      { deep: true },
    );
    expect(rows.length).toBeGreaterThan(0);

    // Each half, so the split cannot move when the labels do (they change on
    // every card and in every language).
    const halves = renderer.root.findAll(
      (node) =>
        typeof node.props?.className === 'string' && node.props.className.includes('flex-1'),
      { deep: true },
    );
    const labelled = new Set(halves.map((node) => textIn(node)).filter(Boolean));
    expect([...labelled].sort()).toEqual([COPY.cancel, COPY.next].sort());

    unmount(renderer);
  });
});

/**
 * No dash anywhere in this copy, in any language.
 *
 * An em dash reads as an aside, and every sentence here is load-bearing: what
 * following a channel commits you to, why there is no reply box, whose words
 * these are. It also sets prose that a translator then has to imitate, and the
 * three catalogs drifted apart on exactly that before (English reached for the
 * dash twice, Spanish and Italian used a colon and read better for it).
 *
 * A hyphen INSIDE a word is untouched, because that is spelling rather than
 * punctuation and some languages need it. What is rejected is a dash standing
 * between clauses, in any of its shapes: the check is written against a
 * character CLASS rather than the em dash alone, so a well-meaning swap to an en
 * dash or a spaced hyphen does not slip through.
 */
describe('the copy carries no dashes, in any language', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const DASHES = /[—–‒―−]|(?:^|\s)-(?:\s|$)/;
  // Derived from the locales directory, not listed. A hand-written list is how
  // this rule came to cover three languages while twelve others were added
  // without it — and a gate that skips what its map omits is not a gate.
  const CATALOGS = Object.fromEntries(
    fs
      .readdirSync(path.join(__dirname, '../../../locales'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => [name.replace(/\.json$/, ''), require(`@/locales/${name}`)]),
  ) as Record<string, Record<string, unknown>>;

  /**
   * The one place a dash is punctuation rather than style.
   *
   * Russian writes `Канал — это аккаунт`, where the dash stands in for the
   * elided copula; without it the sentence is not the same sentence. Forbidding
   * it would make the Russian worse to satisfy an English style rule, which is
   * the wrong trade. Every other dash the twelve new locales introduced was
   * stylistic, and their translators removed them when asked.
   *
   * An exemption has to name a string and a reason. The SCOPE is derived so a
   * new locale cannot silently escape the rule; excusing a string is the part
   * that stays deliberate.
   */
  const GRAMMATICAL_DASHES: Record<string, string[]> = {
    ru: ['step1.body'],
  };

  function strings(node: unknown, path: string): [string, string][] {
    if (typeof node === 'string') return [[path, node]];
    if (node && typeof node === 'object') {
      return Object.entries(node).flatMap(([key, value]) =>
        strings(value, path ? `${path}.${key}` : key),
      );
    }
    return [];
  }

  // These catalogs mix flat dotted keys with nested objects, and which spelling
  // a given key uses is not stable — a merge can rewrite a whole file into the
  // flat form. Selecting by path prefix after flattening reads the same either
  // way; reaching for `catalog.channels.explainer` throws the moment the file
  // is written flat, which is how this test first broke.
  const PREFIX = 'channels.explainer.';

  it.each(Object.keys(CATALOGS))('%s', (language) => {
    const excused = new Set(GRAMMATICAL_DASHES[language] ?? []);
    const entries = strings(CATALOGS[language], '')
      .filter(([keyPath]) => keyPath.startsWith(PREFIX))
      .map(([keyPath, value]): [string, string] => [keyPath.slice(PREFIX.length), value])
      .filter(([keyPath]) => !excused.has(keyPath));

    // Vacuity floor: an explainer that lost its copy would pass every assertion
    // below by having nothing to check.
    expect(entries.length).toBeGreaterThanOrEqual(11 - excused.size);

    expect(entries.filter(([, value]) => DASHES.test(value)).map(([keyPath]) => keyPath)).toEqual([]);
  });

  // An exemption list is the same hand-maintained map the derived scope
  // replaced, only smaller — and it fails the same quiet way. If someone
  // rewrites the Russian sentence without its copula dash, the entry stops
  // doing anything and silently keeps that one key exempt forever. So every
  // exemption has to still be EXERCISED: the string it excuses must actually
  // carry a dash, or the entry is stale and has to go.
  it.each(Object.entries(GRAMMATICAL_DASHES).flatMap(([language, keys]) => keys.map((key) => [language, key])))(
    'the %s exemption for %s is still needed',
    (language, key) => {
      const value = strings(CATALOGS[language], '').find(([keyPath]) => keyPath === `${PREFIX}${key}`)?.[1];

      // A missing key is a stale exemption too, and a louder one.
      expect(value).toBeDefined();
      expect(DASHES.test(value as string)).toBe(true);
    },
  );

  it('still accepts a hyphen inside a word, so the rule is about punctuation', () => {
    // Without this the check reads as "no hyphen character at all", which would
    // be a different and wrong rule for a language that hyphenates.
    expect(DASHES.test('a well-known channel')).toBe(false);
    expect(DASHES.test('a channel — like this')).toBe(true);
    expect(DASHES.test('a channel - like this')).toBe(true);
  });
});
