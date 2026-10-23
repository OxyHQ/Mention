import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..', '..', '..');
const read = (relativePath: string) => readFileSync(join(FRONTEND, relativePath), 'utf8');

describe('Edit Profile presentation', () => {
  it('opens Edit profile as a Settings page from the profile button and the direct route', () => {
    const header = read('components/Profile/ProfileHeader.tsx');
    const route = read('app/(app)/edit-profile.tsx');
    expect(header).toMatch(/requestSettings\('\/settings\/edit-profile'\)/);
    expect(route).toMatch(/createSettingsRoute\('edit-profile'\)/);
    expect(read('components/settings/settingsRoutes.ts')).toMatch(/'edit-profile'/);
  });

  it('presents the header at its real 3:1 ratio with accessible edit and remove actions', () => {
    const banner = read('components/Profile/EditProfile/BannerSection.tsx');
    expect(banner).toMatch(/aspect-\[3\/1\]/);
    expect(banner).toMatch(/accessibilityLabel=\{`\$\{t\('common\.edit'\)\}/);
    expect(banner).toMatch(/accessibilityLabel=\{`\$\{t\('common\.remove'\)\}/);
    expect(banner).toMatch(/defaultVisibility: 'public'/);
  });
});

describe('profile refresh wiring', () => {
  it('joins the profile chrome and pinned post refresh to the feed gesture', () => {
    const tabs = read('components/Profile/ProfileTabs.tsx');
    expect(tabs).toMatch(/onProfileRefresh\?\.\(\)/);
    expect(tabs).toMatch(/refetchPinnedPost\(\)/);
    expect(tabs.match(/onRefresh=\{refreshProfileSurface\}/g)).toHaveLength(2);
  });

  it('runs screen-owned refresh beside the feed refresh, for both platforms', () => {
    // One refresh path in the shared core; both platform Feeds call it.
    expect(read('components/Feed/useFeedCore.tsx')).toMatch(
      /Promise\.all\(\[refreshSession\(\), onRefresh\?\.\(\)\]\)/,
    );
    for (const platform of ['native', 'web']) {
      expect(read(`components/Feed/Feed.${platform}.tsx`)).toMatch(/useFeedCore\(props\)/);
    }
  });
});
