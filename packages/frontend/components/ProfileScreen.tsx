import type React from 'react';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter, Redirect, type Href } from '@/lib/navigation/router';

import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import {
  ProfileShell,
  ProfileTabBarRow,
  laneTabKey,
  usePersonProfileView,
  type ProfileScreenProps,
  type ProfileTabDescriptor,
} from './Profile';

/**
 * ONE PERSON's profile page, at `/@<handle>` — the NATIVE composition.
 *
 * Person-shaped throughout, and deliberately so: it has a banner, a poke, the
 * full tab strip, a self view with edit/analytics/settings, and sub-routes under
 * its own URL family. A CHANNEL satisfies none of that and has its own screen
 * (`ChannelScreen`); the two share the chrome, the body, the account lookup and
 * the canonicalization, and nothing else.
 *
 * This file renders the WHOLE page — chrome and tab content together — because
 * on native it has to: on the post and grid tabs the feed's own list IS the
 * scroll container, and it is handed the profile summary as its list header and
 * the tab strip as its sticky row. A strip that is a route-owned list's sticky
 * header cannot simultaneously be layout chrome. The web build has no such
 * constraint (the DOCUMENT scrolls) and does split the two — see
 * `Profile/ProfileChromeFrame.tsx`, which carries the full account of the seam.
 *
 * `ProfileScreen.web.tsx` is the other half of that pair: on web this component
 * renders only the tab's CONTENT, and everything above it comes from the
 * `[username]` layout.
 */
const ProfileScreen: React.FC<ProfileScreenProps> = ({
  username,
  tab = 'posts',
  laneId,
  isRootTab = false,
}) => {
  const router = useRouter();
  const { t } = useTranslation();
  // Active tab — local state so switching tabs does not remount the page.
  // Held as the tab's KEY, not its index: the strip's length depends on how
  // many lanes the publisher has, so an index means a different tab before and
  // after that list loads. A lane deep link therefore paints `posts` for one
  // frame and settles on the lane once its key resolves.
  const [activeTabKey, setActiveTabKey] = useState<string>(() =>
    laneId ? laneTabKey(laneId) : tab,
  );

  // The root profile lives inside the retained /you tab: its selection must
  // stay local. Replacing it with /@handle/media removes the entire root pager
  // from the native stack (and attempts to pop its last screen on Android).
  // A pushed profile owns a canonical profile route, so its URL follows the
  // selection with `replace`, without a history entry per internal tab.
  // WEB does the opposite — there the route owns the selection and each tab
  // is pushed, which is what makes Back return to the tab you came from. It
  // can, because there the strip outlives the navigation; here it does not.
  const onSelectTab = useCallback(
    (descriptor: ProfileTabDescriptor, href: Href) => {
      setActiveTabKey(descriptor.key);
      if (!isRootTab) router.replace(href);
    },
    [isRootTab, router],
  );

  const view = usePersonProfileView({ activeKey: activeTabKey, onSelectTab, username });

  // A channel account's page is `/c/<handle>`. Sitting on `/@<handle>` for one
  // is a URL nobody should keep — a post row links every author to `/@`, since
  // the DTO says nothing about account kind, so this is how a reader reaches a
  // channel at all. The rule itself lives in `profileRoute.ts`, shared with the
  // channel screen so the two can never disagree about which way to send.
  if (view.canonicalHref) {
    return <Redirect href={view.canonicalHref} />;
  }

  const tabBar = (
    <ProfileTabBarRow>
      <Tabs
        value={view.activeDescriptor?.key ?? 'posts'}
        onValueChange={(key) => {
          if (key === 'manage-lanes') router.push('/lanes');
          else view.selectTab(key);
        }}
        variant="underline"
      >
        {view.tabDescriptors
          .map((descriptor) => ({
            id: descriptor.key,
            label: descriptor.label,
          }))
          .map((tab: { id: string; label: string; count?: number }) => (
            <TabsTrigger key={tab.id} value={tab.id} label={tab.label} count={tab.count} />
          ))}
        {view.isOwnProfile && (
          <TabsTrigger value="manage-lanes" label={t('lanes.title', { defaultValue: 'Lanes' })} />
        )}
      </Tabs>
    </ProfileTabBarRow>
  );

  return (
    <>
      {/* `web:z-auto` so this profile wrapper does not become its own
                stacking context and trap the sticky header chrome below the
                panel's bleed-mask/border overlays (see ProfileShell's root for
                the full rationale). No effect on native. */}
      <View className="flex-1 web:z-auto">
        {view.seo}
        <ProfileShell
          chrome={view.chrome}
          loading={view.loading}
          profileData={view.profileData}
          notFound={view.notFound}
          onRetry={view.refresh}
          banner={{ uri: view.bannerUri }}
          headerActions={view.headerActions}
          summary={view.summary}
          tabBar={tabBar}
          tabs={view.tabs}
          isRootTab={isRootTab}
        />
      </View>
    </>
  );
};

export default ProfileScreen;
