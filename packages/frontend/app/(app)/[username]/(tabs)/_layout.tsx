import ProfileTabsChrome from '@/components/Profile/ProfileTabsChrome';

/**
 * The profile's TAB routes, grouped so a layout can wrap exactly them.
 *
 * `(tabs)` is a `(group)` segment, so it is URL-transparent: `/@ana/replies` is
 * still `/@ana/replies`. It exists purely to draw a boundary. The profile's tab
 * strip and the chrome above it are rendered by this layout on web, and the
 * profile's OTHER routes — `/followers`, `/following`, `/about`, `/connections`,
 * `/in-common`, `/who-may-know` — must not inherit them: each is a full screen
 * with its own header and back button, and a banner and identity summary stacked
 * above one would be a second, contradictory chrome. Those six stay flat, one
 * level up, beside this group.
 *
 * The layout body itself is a platform pair — see `ProfileTabsChrome.tsx` for
 * why web and native compose the profile differently, and why that difference is
 * deliberate rather than a native build that has not caught up.
 */
export default function ProfileTabsLayout() {
  return <ProfileTabsChrome />;
}
