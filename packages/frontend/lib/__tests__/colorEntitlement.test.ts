import {
  APP_DEFAULT_COLOR_PRESET,
  entitledColorNames,
  isColorEntitled,
} from '@/lib/colorEntitlement';

/**
 * Two gates, and they are not interchangeable: `oxy` and `faircoin` belong to
 * those accounts and cannot be bought, while `mono` is what a subscription buys.
 * Everything else is everyone's.
 *
 * The preset table is MOCKED so these cases state the rule directly instead of
 * restating whatever Bloom currently ships (which is asserted in Bloom's own
 * `theme/__tests__/color-preset-gates.test.ts`, and which jest cannot import
 * here anyway — Bloom's `react-native` export condition resolves to source).
 * That split is deliberate: Bloom owns WHAT is gated, this owns WHETHER a given
 * viewer clears it.
 */
jest.mock('@oxyhq/bloom/theme', () => ({
  FREE_COLOR_NAMES: ['teal', 'blue', 'red'],
  HANDLE_COLOR_NAMES: ['oxy', 'faircoin'],
  PREMIUM_COLOR_NAMES: ['mono'],
}));

const NOBODY = { username: undefined, isPremium: false };

describe('colour entitlement', () => {
  it('gives the free presets to everyone, including a signed-out viewer', () => {
    expect(entitledColorNames(NOBODY)).toEqual(['teal', 'blue', 'red']);
  });

  it('never sells a reserved brand colour', () => {
    const richStranger = { username: 'someone', isPremium: true };
    expect(isColorEntitled('oxy', richStranger)).toBe(false);
    expect(isColorEntitled('faircoin', richStranger)).toBe(false);
    // ...and paying still buys the one that IS for sale.
    expect(isColorEntitled('mono', richStranger)).toBe(true);
  });

  it('gives a reserved colour only to the account that owns the handle', () => {
    expect(isColorEntitled('oxy', { username: 'oxy', isPremium: false })).toBe(true);
    // ...and only that one — owning a handle is not a subscription.
    expect(isColorEntitled('faircoin', { username: 'oxy', isPremium: false })).toBe(false);
    expect(isColorEntitled('mono', { username: 'oxy', isPremium: false })).toBe(false);
  });

  it('matches the handle regardless of case or padding', () => {
    expect(isColorEntitled('faircoin', { username: '  FairCoin ', isPremium: false })).toBe(true);
  });

  it('withholds the sold preset from a viewer who is not paying', () => {
    expect(isColorEntitled('mono', NOBODY)).toBe(false);
    expect(entitledColorNames(NOBODY)).not.toContain('mono');
  });

  // The revocation target has to be something the lapsed viewer may actually
  // have: falling back to a gated preset would hand out on revocation exactly
  // what the revocation exists to take away. Bloom's own built-in default is
  // `oxy`, which is handle-gated — hence a Mention-side constant.
  it('falls back to a preset every viewer is entitled to', () => {
    expect(isColorEntitled(APP_DEFAULT_COLOR_PRESET, NOBODY)).toBe(true);
  });
});
