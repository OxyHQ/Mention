import { PROFILE_AVATAR_OVERLAP, PROFILE_BANNER_HEIGHT, profileTabsOffset } from '../ProfilePageHeader';

jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/components/UserName', () => ({ __esModule: true, default: () => null }));

// The stats row and a tab reselect scroll here. The summary starts
// `PROFILE_AVATAR_OVERLAP` short of the banner's bottom edge, so the banner's
// height alone lands 45px below the tab strip.
test('the tab strip starts where the summary ends, not a banner height after it', () => {
  expect(PROFILE_BANNER_HEIGHT).toBe(170);
  expect(PROFILE_AVATAR_OVERLAP).toBe(45);
  expect(profileTabsOffset(0)).toBe(125);
  expect(profileTabsOffset(255)).toBe(380);
});
