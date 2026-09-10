import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..', '..', '..');
const read = (relativePath: string) =>
  readFileSync(join(FRONTEND, relativePath), 'utf8');

describe('Edit Profile presentation', () => {
  it('keeps the navigable route below the native camera safe area', () => {
    const route = read('app/(app)/edit-profile.tsx');
    expect(route).toMatch(/<SafeAreaView[^>]+edges=\{\['top'\]\}/);
    expect(route).toMatch(/<EditProfileForm\s*\/>/);
  });

  it('opens the profile button in the app-level Bloom content dialog', () => {
    const header = read('components/Profile/ProfileHeader.tsx');
    const dialog = read('components/common/ContentDialog.tsx');
    expect(header).toMatch(/showContentDialog\(\{/);
    expect(header).toMatch(/render: \(\) => <EditProfileForm \/>/);
    expect(header).not.toMatch(/router\.push\(['"]\/edit-profile/);
    expect(dialog).toMatch(/from '@oxy\.so\/bloom\/dialog'/);
    expect(dialog).toMatch(/placement=\{\{ base: 'bottom', md: 'center' \}\}/);
  });

  it('shares one form between the route and dialog instead of duplicating editor state', () => {
    const route = read('app/(app)/edit-profile.tsx');
    const header = read('components/Profile/ProfileHeader.tsx');
    expect(route).not.toMatch(/BannerSection|PinnedMediaSection|ColorSwatchPicker/);
    expect(header).not.toMatch(/BannerSection|PinnedMediaSection|ColorSwatchPicker/);
    expect(read('components/Profile/EditProfile/EditProfileForm.tsx')).toMatch(
      /<BannerSection \/>[\s\S]+<ColorSwatchPicker[\s\S]+<PinnedMediaSection \/>/,
    );
  });

  it('keeps the direct route available for deep links and accessibility', () => {
    expect(read('app/(app)/edit-profile.tsx')).toMatch(/export default function EditProfileScreen/);
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

  it.each(['native', 'web'])('runs screen-owned refresh beside the %s feed refresh', (platform) => {
    expect(read(`components/Feed/Feed.${platform}.tsx`)).toMatch(
      /Promise\.all\(\[feedRefresh\(\), onRefresh\?\.\(\)\]\)/,
    );
  });
});
