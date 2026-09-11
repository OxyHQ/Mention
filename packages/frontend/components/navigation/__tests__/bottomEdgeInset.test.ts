import { resolveBottomEdgeInset } from '@/components/navigation/bottomEdgeInset';

describe('resolveBottomEdgeInset', () => {
  it.each([
    ['iOS', false, 34],
    ['Android', false, 24],
    ['web', true, 0],
  ])('uses the platform fallback with no claimed edge on %s', (_platform, isWeb, expected) => {
    expect(resolveBottomEdgeInset(0, expected, isWeb)).toBe(expected);
  });

  it.each([
    ['iOS', false, 34],
    ['Android', false, 24],
    ['web', true, 0],
  ])('uses Bloom occupancy without counting safe area twice on %s', (_platform, isWeb, safeArea) => {
    expect(resolveBottomEdgeInset(76, safeArea, isWeb)).toBe(76);
  });
});
