import React from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ProfileTabBarRow } from '../ProfileTabBarRow';

/**
 * The profile tab row is CHROME: it pins over the scrolling profile feed, so it
 * has to be opaque in the colour of the column it landed in — the shell's
 * `ContentPanel` today, something else tomorrow.
 *
 * It used to say that as `bg-card`, which named a colour instead of asking for
 * one, and a whole commit's worth of those had to be swept by hand when the
 * column's fill changed. This file pins the shape that replaced it: the row
 * paints what `useSurfaceFill()` answers, whatever that is. The sentinel colour
 * is deliberately not a palette value — a row that went back to naming `card`
 * would not produce it, and nor would a row that painted nothing.
 *
 * `bg-card` is asserted absent as well as the fill asserted present, because the
 * two are not the same failure: a class left behind alongside the style wins on
 * neither platform predictably, and it would re-open the sweep this replaced.
 */

/**
 * Bloom's `styles` subpath ships untranspiled ESM that Jest cannot require, and
 * every other Bloom subpath in this suite is stubbed the same way. The value is
 * a sentinel: it stands in for "whatever the surrounding surface published".
 */
const PUBLISHED_FILL = '#0f1e2d';

jest.mock('@oxy.so/bloom/styles', () => ({ useSurfaceFill: () => '#0f1e2d' }));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#666666' } }),
}));

jest.mock('@oxy.so/bloom/icons', () => ({ RiGitMergeLine: () => null }));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

/**
 * `act` is required rather than decorative: NativeWind's className interop
 * resolves its styles in an effect, so the tree read outside it is the one
 * before the classes applied.
 */
function renderRow(showLanes: boolean) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ProfileTabBarRow showLanes={showLanes}>
        <View testID="strip" />
      </ProfileTabBarRow>,
    );
  });
  return renderer;
}

/** The row itself — the outermost host view, the one carrying the fill. */
function rowProps(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(View)[0].props as {
    className?: string;
    style?: { backgroundColor?: string };
  };
}

describe('profile tab row surface', () => {
  it('paints the fill the surrounding surface published', () => {
    const props = rowProps(renderRow(false));

    expect(props.style?.backgroundColor).toBe(PUBLISHED_FILL);
  });

  it('keeps the tab strip in the second sticky tier below the profile header', () => {
    const props = rowProps(renderRow(false));

    expect(props.className).toContain('web:sticky');
    expect(props.className).toContain('web:top-14');
    expect(props.className).toContain('web:z-40');
  });

  it('names no colour of its own', () => {
    const props = rowProps(renderRow(false));

    expect(props.className ?? '').not.toContain('bg-card');
  });

  it('keeps the fill when the lanes button is beside the tabs', () => {
    // The button sits OUTSIDE the tab strip's own scroller, so it is drawn by
    // the row rather than by the strip — the branch that could paint its own
    // container and lose the surface.
    const props = rowProps(renderRow(true));

    expect(props.style?.backgroundColor).toBe(PUBLISHED_FILL);
  });
});
