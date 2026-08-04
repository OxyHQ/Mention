import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
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
 * The preset table is MOCKED, as it is in every other suite here (jest cannot
 * parse Bloom's `react-native` export condition, which resolves to source). That
 * is the right seam anyway: which presets are gated is Bloom's own question and
 * is asserted there, in `theme/__tests__/color-preset-gates.test.ts`. Importing
 * the real lists through a mock would make this file look like it checked them
 * while checking a fixture.
 */
jest.mock('@oxyhq/bloom/theme', () => ({
  APP_COLOR_PRESETS: {
    teal: { name: 'teal', hex: '#005c67' },
    blue: { name: 'blue', hex: '#0085fe' },
    red: { name: 'red', hex: '#ef4444' },
    oxy: { name: 'oxy', hex: '#c46ede' },
    faircoin: { name: 'faircoin', hex: '#9ffb50' },
    mono: { name: 'mono', hex: '#000000' },
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

const expected = (colors: readonly Name[]): string[] =>
  colors.flatMap((name) => (name === 'mono' ? ['#000000', '#ffffff'] : [HEX[name]]));

describe('ColorSwatchPicker', () => {
  it('renders exactly the presets it is given, in order', () => {
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
