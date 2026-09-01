import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';

/**
 * THE PAYWALL IS THE LIST THIS COMPONENT IS HANDED.
 *
 * The shipped version took only the EXTRA presets and rendered them on top of
 * Bloom's `APP_COLOR_NAMES` — a list that already contains every gated one. So
 * `oxy` and `faircoin`, which belong to those two accounts, were offered to
 * everybody, and a subscriber saw their own unlocks a second time. Nothing
 * failed: a picker rendering more swatches than intended looks exactly like a
 * picker working.
 *
 * These assert the property that closes the class rather than the one
 * regression: the component renders EXACTLY what it was given, in that order,
 * and adds nothing of its own. A component that appends to a list it does not
 * control cannot express a restriction, whatever the appended values are.
 *
 * The registry groups are MOCKED (jest cannot parse Bloom's `react-native`
 * export condition, which resolves to source). That is the right seam: Bloom
 * owns catalog completeness and gate metadata; this suite owns the consumer's
 * filtering, grouping and paint behavior.
 */
jest.mock('@oxyhq/bloom/theme', () => ({
  COLOR_PRESET_FAMILIES: ['brand', 'ocean', 'sunset', 'neutral'],
  COLOR_PRESET_GROUPS: {
    brand: {
      name: 'brand',
      displayName: 'Brand',
      description: 'Reserved identities.',
      presets: [
        { name: 'oxy', displayName: 'Oxy', family: 'brand', hex: '#c46ede' },
        { name: 'faircoin', displayName: 'FairCoin', family: 'brand', hex: '#9ffb50' },
      ],
    },
    ocean: {
      name: 'ocean',
      displayName: 'Ocean',
      description: 'Aquatic identities.',
      presets: [
        { name: 'teal', displayName: 'Teal', family: 'ocean', hex: '#005c67' },
        { name: 'blue', displayName: 'Blue + Signal', family: 'ocean', hex: '#0085fe', tertiaryHex: '#ffd000' },
      ],
    },
    sunset: {
      name: 'sunset',
      displayName: 'Sunset',
      description: 'Warm identities.',
      presets: [{ name: 'red', displayName: 'Red', family: 'sunset', hex: '#ef4444' }],
    },
    neutral: {
      name: 'neutral',
      displayName: 'Neutral',
      description: 'Colorless identities.',
      presets: [{ name: 'mono', displayName: 'Monochrome', family: 'neutral', hex: '#000000', variant: 'monochrome' }],
    },
  },
}));

type Name = 'teal' | 'blue' | 'red' | 'oxy' | 'faircoin' | 'mono';

const FREE: readonly Name[] = ['teal', 'blue', 'red'];
const GATED: readonly Name[] = ['oxy', 'faircoin', 'mono'];

const HEX: Record<Name, string> = {
  teal: '#005c67',
  blue: '#0085fe',
  red: '#ef4444',
  oxy: '#c46ede',
  faircoin: '#9ffb50',
  mono: '#000000',
};

const TERTIARY: Partial<Record<Name, string>> = {
  blue: '#ffd000',
};

/**
 * Read the swatches back by the colour each one PAINTS, not by React key: the
 * repo-wide `react-native` mock replaces `Pressable`, so `findAllByType` against
 * the real export matches nothing and every assertion below would pass
 * vacuously. A background colour is what a user actually sees, and the mocked
 * preset table above gives each name a distinct one.
 */
function swatchColors(colors: readonly Name[]): string[] {
  let created: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    created = TestRenderer.create(
      <ColorSwatchPicker
        value="teal"
        onChange={() => undefined}
        colors={colors as never}
      />,
    );
  });
  const tree = created as TestRenderer.ReactTestRenderer;
  const painted = tree.root.findAllByType(View).flatMap((node) => {
    const style = node.props.style as { backgroundColor?: string } | undefined;
    return style?.backgroundColor ? [style.backgroundColor] : [];
  });
  act(() => tree.unmount());
  return painted;
}

const FAMILY_ORDER: readonly Name[] = ['oxy', 'faircoin', 'teal', 'blue', 'red', 'mono'];

const expected = (colors: readonly Name[]): string[] =>
  FAMILY_ORDER.filter((name) => colors.includes(name)).flatMap((name) => {
    if (name === 'mono') return ['#000000', '#ffffff'];
    return TERTIARY[name] ? [HEX[name], TERTIARY[name]] : [HEX[name]];
  });

describe('ColorSwatchPicker', () => {
  it('renders exactly the presets it is given in Bloom family order', () => {
    const given: readonly Name[] = ['blue', 'teal', 'red'];
    expect(swatchColors(given)).toEqual(expected(given));
  });

  it('adds nothing to a free-only list', () => {
    const rendered = swatchColors(FREE);
    for (const gated of GATED) expect(rendered).not.toContain(HEX[gated]);
    // Vacuity floor: rendering nothing at all would satisfy the loop above.
    expect(rendered).toEqual(expected(FREE));
  });

  it('draws an unlocked preset once, not twice', () => {
    const given: readonly Name[] = [...FREE, 'mono'];
    const rendered = swatchColors(given);
    expect(rendered).toEqual(expected(given));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('shows curated identity and action colors without inventing the pairing', () => {
    expect(swatchColors(['blue'])).toEqual(['#0085fe', '#ffd000']);
  });

  it('reads family and preset labels from Bloom metadata', () => {
    let created: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      created = TestRenderer.create(
        <ColorSwatchPicker value="teal" onChange={() => undefined} colors={['blue'] as never} />,
      );
    });
    const tree = created as TestRenderer.ReactTestRenderer;
    const labels = tree.root.findAllByType(Text).map((node) => node.props.children);
    act(() => tree.unmount());

    expect(labels).toContain('Ocean');
    expect(labels).toContain('Aquatic identities.');
    expect(labels).toContain('Blue + Signal');
    expect(labels).not.toContain('blue');
  });

  // The colourless preset's seed is pure black, so a single-colour chip vanishes
  // against a dark page — the one mode a user is most likely reaching for it in.
  it('draws the colourless preset as both halves, not one black chip', () => {
    let created: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      created = TestRenderer.create(
        <ColorSwatchPicker value="teal" onChange={() => undefined} colors={['mono'] as never} />,
      );
    });
    const tree = created as TestRenderer.ReactTestRenderer;
    const backgrounds = tree.root.findAllByType(View).flatMap((node) => {
      const style = node.props.style as { backgroundColor?: string } | undefined;
      return style?.backgroundColor ? [style.backgroundColor] : [];
    });
    act(() => tree.unmount());
    expect(backgrounds).toContain('#000000');
    expect(backgrounds).toContain('#ffffff');
  });
});
