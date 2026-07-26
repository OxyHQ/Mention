import {
  TAB_NAMES,
  isVirtualizedProfileGridTab,
  isVirtualizedProfileFeedTab,
  shouldFeedOwnProfileScroll,
  shouldGridOwnProfileScroll,
} from '@/components/Profile/types';

describe('profile tab scroll ownership', () => {
  it.each(['posts', 'replies', 'likes', 'boosts'] as const)(
    'lets the %s Feed own the native virtualized scroll',
    (tab) => {
      expect(isVirtualizedProfileFeedTab(tab)).toBe(true);
    },
  );

  it.each(['media', 'videos'] as const)(
    'lets the %s grid own the native virtualized scroll',
    (tab) => {
      expect(isVirtualizedProfileGridTab(tab)).toBe(true);
    },
  );

  it.each(['feeds', 'starter_packs', 'lists'] as const)(
    'keeps the bounded card collection %s on the profile content scroller',
    (tab) => {
      expect(isVirtualizedProfileFeedTab(tab)).toBe(false);
      expect(isVirtualizedProfileGridTab(tab)).toBe(false);
    },
  );

  it('classifies every public profile tab exactly once', () => {
    const classified = TAB_NAMES.filter((tab) => (
      isVirtualizedProfileFeedTab(tab) ||
      isVirtualizedProfileGridTab(tab) ||
      ['feeds', 'starter_packs', 'lists'].includes(tab)
    ));
    expect(classified).toEqual(TAB_NAMES);
  });

  it('keeps web document scrolling and restricted-profile fallback intact', () => {
    expect(shouldFeedOwnProfileScroll({
      tab: 'posts',
      isWeb: true,
      isPrivate: false,
      isOwnProfile: false,
    })).toBe(false);
    expect(shouldFeedOwnProfileScroll({
      tab: 'posts',
      isWeb: false,
      isPrivate: true,
      isOwnProfile: false,
    })).toBe(false);
    expect(shouldFeedOwnProfileScroll({
      tab: 'posts',
      isWeb: false,
      isPrivate: true,
      isOwnProfile: true,
    })).toBe(true);
  });

  it('keeps grid ownership native-only and preserves restricted profiles', () => {
    expect(shouldGridOwnProfileScroll({
      tab: 'media',
      isWeb: false,
      isPrivate: false,
      isOwnProfile: false,
    })).toBe(true);
    expect(shouldGridOwnProfileScroll({
      tab: 'videos',
      isWeb: true,
      isPrivate: false,
      isOwnProfile: false,
    })).toBe(false);
    expect(shouldGridOwnProfileScroll({
      tab: 'media',
      isWeb: false,
      isPrivate: true,
      isOwnProfile: false,
    })).toBe(false);
  });
});
