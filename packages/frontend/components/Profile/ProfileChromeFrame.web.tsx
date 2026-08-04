import React, { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { router, usePathname, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { RouterTabs, type RouterTabItem } from '@oxyhq/bloom/tabs/expo-router';

import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
import { EmptyState } from '@/components/common/EmptyState';
import { NoUpdatesIllustration } from '@/assets/illustrations/NoUpdates';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { useSafeBack } from '@/hooks/useSafeBack';

import { ProfileChromeLayers } from './ProfileChromeLayers';
import { ProfileSkeleton } from './ProfileSkeleton';
import { ProfileTabBarRow } from './ProfileTabBarRow';
import { usePersonProfileView } from './hooks/usePersonProfileView';
import { profileTabHref, profileTabSelectionFromPathname } from './profileTabRoute';
import type { ProfileChromeFrameProps, ProfileTabDescriptor } from './types';

/** What the frame is drawing above the routed child right now. */
type ChromeState = 'off' | 'skeleton' | 'notFound' | 'ready';

/**
 * The `[username]` layout's body — WEB, where it owns the profile chrome.
 *
 * The banner, the identity summary, the action cluster and the tab strip are
 * rendered HERE, above the `<Slot/>` that renders whichever child the URL names.
 * The placement is the whole fix: a strip rendered inside each tab screen is
 * unmounted by the navigation it performs, so the chrome blanked for the 597ms
 * the incoming tab's async chunk took to arrive (measured on production), the
 * skeleton that replaced it guessed the first tab was selected, and the real bar
 * snapped into place when the screen finally committed. None of that is a page
 * load — the JS context survives throughout — it is a remount, and a layout does
 * not remount. `/explore` has the identical `<Slot/>` and has never had the
 * problem, because it renders its strip in the LAYOUT.
 *
 * Back is fixed by the same move for a different reason: `RouterTabs` PUSHES, so
 * each tab is a history entry and Back returns to the tab the reader came from
 * rather than leaving the profile. The strip could not push while it lived in
 * the screens, because every entry would then rebuild it.
 *
 * See `ProfileChromeFrame.tsx` (the native half) for why the two platforms
 * differ, and why native is not simply behind.
 *
 * ## The tab routes are FLAT, and that is load-bearing
 *
 * `index.tsx`, `replies.tsx`, … and `lane/[laneId].tsx` are direct children of
 * `[username]`, beside `/followers`, `/following`, `/about`, `/connections`,
 * `/in-common` and `/who-may-know`. An earlier version of this change grouped
 * the tabs under a nested `(tabs)` segment so that a layout could wrap exactly
 * them; it shipped and was reverted. `router.push('/@handle')` from another
 * profile creates a second `[username]` entry carrying NO nested state, its
 * child navigator then has to choose an initial route, and it settled on
 * `about` — which expo-router wrote into the URL. Traced with
 * `useRootNavigationState()`, reproduced 3/3 locally and once on production.
 * `unstable_settings = { anchor: '(tabs)' }` — the router's own documented
 * mechanism for it — had no effect. So a pushed `[username]` entry's default
 * child must be a real route, and the boundary the group used to draw is drawn
 * here instead, by asking the pathname.
 *
 * ## THREE INVARIANTS, all load-bearing
 *
 *  - **`children` is rendered in EVERY branch, at ONE tree position.** It is the
 *    segment's NAVIGATOR. A layout that swaps its navigator for a plain screen
 *    leaves the segment with no navigator in the navigation state, and on web
 *    the remount that follows chases `usePathname()` until React aborts the
 *    render ("Maximum update depth exceeded", React error #185) —
 *    `[username]/_layout.tsx` carries that account. React reconciles by
 *    POSITION, so a conditional that moved it between two parents would destroy
 *    and rebuild it on every crossing into `/followers` and back; the chrome
 *    around it comes and goes instead, and the navigator never moves.
 *  - **The six non-tab siblings get NO chrome.** Each is a full screen with its
 *    own header and back arrow (`connections.tsx`, `AccountInfoScreen`), and a
 *    banner and identity summary stacked above one would be a second,
 *    contradictory chrome. `profileTabSelectionFromPathname` answers `null`
 *    there — and for any child added later that it has never heard of, which is
 *    the direction that fails safe.
 *  - **The active tab is read from the PATHNAME, not from the routed screen.**
 *    This layout owns `useProfileChrome`, and on web that hook's scroll listener
 *    is the profile's only paginator — it pages the ACTIVE tab's feed. A layout
 *    that did not know which tab is showing would page the wrong one, and
 *    nothing would fail.
 */
export default function ProfileChromeFrame({ children }: ProfileChromeFrameProps) {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const pathname = usePathname();
  const selection = useMemo(() => profileTabSelectionFromPathname(pathname), [pathname]);
  const active = selection !== null;

  // The strip navigates on its own (it is a `RouterTabs`), so this is reached
  // only from the summary's stats row — "12 posts" jumping to the posts tab.
  // PUSH for the same reason the strip does: a jump the reader can come back
  // from.
  const onSelectTab = useCallback((_descriptor: ProfileTabDescriptor, href: Href) => {
    router.push(href);
  }, []);

  const view = usePersonProfileView({ active, activeKey: selection?.key ?? 'posts', onSelectTab });

  const items = useMemo<RouterTabItem[]>(
    () =>
      view.tabDescriptors.map((descriptor) => ({
        value: descriptor.key,
        label: descriptor.label,
        href: profileTabHref(view.handle, descriptor),
      })),
    [view.tabDescriptors, view.handle],
  );

  // A wrong-family URL (a channel sitting on `/@handle`) holds the skeleton
  // rather than painting a person-shaped chrome for the frame before the routed
  // screen below redirects. The redirect itself is the screen's — see the
  // navigator invariant above.
  const chromeState: ChromeState = !active
    ? 'off'
    : view.loading || view.canonicalHref !== null
      ? 'skeleton'
      : view.profileData
        ? 'ready'
        : 'notFound';
  /**
   * The account the chrome is drawing, or `null` in every other state.
   *
   * One value rather than a boolean beside a null check: each slot below both
   * decides whether to render and narrows `profileData`, and two expressions
   * doing that separately is one edit away from disagreeing.
   */
  const drawing = chromeState === 'ready' ? view.profileData : null;

  const tabBar = (
    <ProfileTabBarRow showLanes={view.isOwnProfile}>
      <RouterTabs
        items={items}
        // The profile strip is itself horizontally scrollable — nine static tabs
        // plus one per lane — so a horizontal pan here means "scroll the strip",
        // and a swipe-to-change-tab gesture would take that drag away from it.
        swipeEnabled={false}
        // Re-tapping the tab you are on conventionally means "back to the top",
        // and here that is the top of the CONTENT rather than of the document —
        // the same place the stats row jumps to, so the two agree.
        onReselect={() => view.chrome.scrollToContent(view.chrome.contentHeight)}
      />
    </ProfileTabBarRow>
  );

  return (
    <BloomColorScope colorPreset={active ? view.colorName : undefined} asChild>
      {/* `web:z-auto` so this profile wrapper does not become its own stacking
          context and trap the sticky header chrome below the panel's
          bleed-mask/border overlays (see ProfileShell's root for the full
          rationale). */}
      <View
        className="flex-1 bg-background web:z-auto relative flex-col"
        style={active ? [rootOverflow, view.chrome.themedStyles.container] : rootOverflow}
      >
        {view.seo}

        {chromeState === 'skeleton' ? <ProfileSkeleton variant="person" /> : null}

        {chromeState === 'notFound' ? (
          <EmptyState
            customIcon={<NoUpdatesIllustration width={200} height={200} />}
            title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
            subtitle={t('profile.notFound.message', {
              defaultValue:
                "This profile couldn't be loaded. The user may not exist or their server may be unavailable.",
            })}
            action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: safeBack }}
          />
        ) : null}

        {drawing ? (
          <ProfileChromeLayers
            chrome={view.chrome}
            banner={{ uri: view.bannerUri }}
            headerActions={view.headerActions}
            profileData={drawing}
          />
        ) : null}

        {/* The one flow column: summary, sticky strip and the routed child, in
            that order. They share a parent on purpose — `position: sticky` is
            scoped to its own flow parent, so a strip in a box that ended above
            the content would unstick the instant the reader scrolled past it.
            The banner/header offsets ride here rather than on each piece, which
            is where `ProfileShell` puts them too.

            When no tab is showing this is a bare `flex-1` box, so the sibling
            screen inside it gets the same room it had when the layout rendered
            nothing but a `<Slot/>`. */}
        <View
          className={drawing ? undefined : 'flex-1'}
          style={
            drawing
              ? [
                  contentLayer,
                  view.chrome.themedStyles.scrollView,
                  view.chrome.themedStyles.contentContainer,
                ]
              : undefined
          }
        >
          {drawing ? view.summary : null}

          {/* Tabs — sticky in the SECOND tier, pinned flush BELOW the header
              chrome band (`panelStickyTabsTopInset`); the chrome layers all pin
              at the FIRST tier, and pinning the strip at that same inset made
              the two bands occupy the same vertical space and OVERLAP. */}
          {drawing ? (
            <View className="web:sticky web:z-[5]" style={view.chrome.panelStickyTabsTopInset}>
              {tabBar}
            </View>
          ) : null}

          {children}
        </View>

        {/* FAB that rides the BottomBar's show/hide (web mobile). */}
        {drawing ? (
          <BottomBarAwareFab
            onPress={() => router.push('/compose')}
            icon={<ComposeIcon size={20} className="text-primary-foreground" />}
            accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
          />
        ) : null}
      </View>
    </BloomColorScope>
  );
}

const rootOverflow = { overflow: 'visible' } as const;

/**
 * Keeps the flow column above the banner (`z-1`) and below the header band
 * (`z-100`), exactly as `ProfileShell` does — the layers and the content are
 * siblings in both compositions, so they need the same tier.
 */
const contentLayer = { zIndex: 3 } as const;
