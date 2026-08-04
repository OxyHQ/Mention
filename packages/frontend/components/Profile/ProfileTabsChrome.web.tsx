import React, { useCallback, useMemo } from 'react';
import { Slot, router, usePathname, type Href } from 'expo-router';
import { View } from 'react-native';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { RouterTabs, type RouterTabItem } from '@oxyhq/bloom/tabs/expo-router';

import { ProfileShell } from './ProfileShell';
import { ProfileTabBarRow } from './ProfileTabBarRow';
import { usePersonProfileView } from './hooks/usePersonProfileView';
import { profileTabFromPathname, profileTabHref } from './profileTabRoute';

/**
 * The profile tab group's layout — WEB, where it owns the chrome.
 *
 * The banner, the identity summary, the action cluster and the tab strip are
 * rendered HERE, above a `<Slot/>` that renders whichever tab the URL names. The
 * placement is the whole fix: a strip rendered inside each tab screen is
 * unmounted by the navigation it performs, so the chrome blanked for the ~300ms
 * the incoming tab's async chunk took to arrive, the skeleton that replaced it
 * guessed the first tab was selected, and the real bar snapped into place when
 * the screen finally committed. None of that is a page load — the JS context
 * survives throughout — it is a remount, and a layout does not remount.
 *
 * Back is fixed by the same move for a different reason: `RouterTabs` PUSHES, so
 * each tab is a history entry and Back returns to the tab the reader came from
 * rather than leaving the profile. The strip could not push while it lived in
 * the screens, because every entry would then rebuild it.
 *
 * See `ProfileTabsChrome.tsx` (the native half) for why the two platforms
 * differ, and why native is not simply behind.
 *
 * TWO INVARIANTS, both load-bearing:
 *
 *  - The `<Slot/>` is rendered in EVERY branch, including while the account is
 *    still loading. A layout that swaps its navigator for a plain screen leaves
 *    the segment with no navigator in the navigation state, and on web the
 *    remount that follows chases `usePathname()` until React aborts the render
 *    ("Maximum update depth exceeded"). `[username]/_layout.tsx` carries the
 *    full account. `ProfileShell` keeps it mounted and merely hidden — that is
 *    what its `tabContent` prop is for.
 *  - The active tab is read from the PATHNAME here, not from the routed screen.
 *    The layout owns `useProfileChrome`, and on web that hook's scroll listener
 *    is the profile's only paginator — it pages the ACTIVE tab's feed. A layout
 *    that did not know which tab is showing would page the wrong one, and
 *    nothing would fail.
 */
export default function ProfileTabsChrome() {
  const pathname = usePathname();
  const selection = useMemo(() => profileTabFromPathname(pathname), [pathname]);

  // The strip navigates on its own (it is a `RouterTabs`), so this is reached
  // only from the summary's stats row — "12 posts" jumping to the posts tab.
  // PUSH for the same reason the strip does: a jump the reader can come back
  // from.
  const onSelectTab = useCallback((_descriptor: unknown, href: Href) => {
    router.push(href);
  }, []);

  const view = usePersonProfileView({ activeKey: selection.key, onSelectTab });

  const items = useMemo<RouterTabItem[]>(
    () =>
      view.tabDescriptors.map((descriptor) => ({
        value: descriptor.key,
        label: descriptor.label,
        href: profileTabHref(view.handle, descriptor),
      })),
    [view.tabDescriptors, view.handle],
  );

  const tabBar = (
    <ProfileTabBarRow showLanes={view.isOwnProfile}>
      <RouterTabs
        items={items}
        // Re-tapping the tab you are on conventionally means "back to the top",
        // and here that is the top of the CONTENT rather than of the document —
        // the same place the stats row jumps to, so the two agree.
        onReselect={() => view.chrome.scrollToContent(view.chrome.contentHeight)}
      />
    </ProfileTabBarRow>
  );

  return (
    <BloomColorScope colorPreset={view.colorName} asChild>
      {/* `web:z-auto` so this profile wrapper does not become its own stacking
          context and trap the sticky header chrome below the panel's
          bleed-mask/border overlays (see ProfileShell's root for the full
          rationale). */}
      <View className="flex-1 bg-background web:z-auto">
        {view.seo}
        <ProfileShell
          chrome={view.chrome}
          // A wrong-family URL (a channel sitting on `/@handle`) holds the
          // skeleton rather than painting a person-shaped chrome for the frame
          // before the routed screen below redirects. The redirect itself is the
          // screen's — see the navigator invariant above.
          loading={view.loading || view.canonicalHref !== null}
          profileData={view.profileData}
          banner={{ uri: view.bannerUri }}
          headerActions={view.headerActions}
          summary={view.summary}
          tabBar={tabBar}
          tabs={view.tabs}
          tabContent={<Slot />}
        />
      </View>
    </BloomColorScope>
  );
}
