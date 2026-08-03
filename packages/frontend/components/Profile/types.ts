import type { ViewStyle, TextStyle, StyleProp } from 'react-native';
import type { AccountKind } from '@oxyhq/core';
import type { ProfileData } from '@/hooks/useProfileData';

/**
 * Profile Screen Types
 * Centralized type definitions following industry standards
 */

import type { useAuth } from '@oxyhq/services/ui/client';

// Tab configuration
export const TAB_NAMES = ['posts', 'replies', 'media', 'videos', 'likes', 'boosts', 'feeds', 'starter_packs', 'lists'] as const;
export type ProfileTab = typeof TAB_NAMES[number];

/**
 * The static tabs a CHANNEL account's profile does NOT get.
 *
 * Not one rule with five instances — THREE separate findings across five tabs,
 * and the differences matter, because the day one of these mechanisms changes it
 * is the reason recorded here that says whether the tab should come back:
 *
 * - **`replies`** — a channel is a publisher, not a conversant, and the model
 *   refuses replies on BOTH sides of it. Nobody may reply to a channel post
 *   (`utils/channelReplyGate.ts`, which keys on the post AUTHOR's account kind at
 *   five write sites), and the channel may not author one either:
 *   `PostCreationService` rejects `publishAsOxyUserId` together with
 *   `parentPostId`, in its own words because "a channel takes no replies at all".
 *
 * - **`likes`** — the tab does not read the channel's posts at all; it reads the
 *   `Like` collection keyed by the LIKER (`gatherAuthorLikes` →
 *   `Like.find({ userId })`). Every writer of that row takes the liker from an
 *   authenticated session (`likePost`) or from a resolved remote actor (the AP
 *   inbox). A channel can never be a session subject — `isActAsEligibleKind`
 *   refuses the kind — so no row can ever name one.
 *
 * - **`feeds`, `starter_packs`, `lists`** — all three are OWNED resources, and in
 *   all three the owner column has exactly one meaningful writer: the session
 *   subject. `CustomFeed.ownerOxyUserId`, `StarterPack.ownerOxyUserId` and
 *   `AccountList.ownerOxyUserId` are each set from `req.user.id` on create, no
 *   create route takes an act-for parameter (`publishAsOxyUserId` exists only on
 *   post creation and on the channel-settings route), and no update route can
 *   reassign an owner. A channel cannot own one, so the tab is not merely empty —
 *   it asks a question the account can never answer. (`FeedGenerator.createdBy`
 *   and mirrored starter packs have a second writer, the atproto mirror, but it
 *   only ever names a `type: 'federated'` account Mention resolved through the
 *   identity bridge, which never requests `kind: 'channel'`.)
 *
 * `boosts` is deliberately NOT here, and the near-miss is worth stating: a boost
 * IS one of the channel's own `Post` rows (the tab is `buildAuthorFeedMatch` plus
 * `boostOf != null` — the same rows the posts tab filters), so it is a well-formed
 * question about a channel. `PostCreationService` does refuse a boost together
 * with `publishAsOxyUserId` today, so the tab is currently empty in practice, but
 * that refusal is a statement about the boost ROW ("its own row belongs to the
 * booster"), not about channels — unlike the five above, nothing about the
 * account kind is what empties it.
 *
 * Lane tabs are unaffected: a lane's owner is an `oxyUserId` and a channel
 * account is one, so a channel has lanes like any other publisher.
 */
const CHANNEL_EXCLUDED_TABS = [
  'replies',
  'likes',
  'feeds',
  'starter_packs',
  'lists',
] as const satisfies readonly ProfileTab[];

/**
 * The static tabs this account kind's profile shows, in strip order.
 *
 * The ONE place the tab set is derived from the account kind. An absent kind
 * reads as `personal` (the column's default), which is also every federated and
 * unresolved profile — none of which is a channel.
 */
export function profileTabsForAccountKind(
  kind: AccountKind | undefined,
): readonly ProfileTab[] {
  if (kind !== 'channel') return TAB_NAMES;
  const excluded = CHANNEL_EXCLUDED_TABS as readonly ProfileTab[];
  return TAB_NAMES.filter((tab) => !excluded.includes(tab));
}

/**
 * One tab of a profile, as the tab bar actually renders it.
 *
 * The profile's tab strip stopped being a fixed tuple the moment a publisher
 * could add lanes to it: a lane tab is DYNAMIC, its position depends on how many
 * lanes the profile has, and there is no compile-time name for it. So the strip
 * is built at runtime and every consumer addresses a tab by its {@link key} —
 * never by a hardcoded index, which is silently wrong the moment anything is
 * inserted before it and throws nothing when it is (the stats row simply jumps
 * to the wrong tab).
 */
export interface ProfileTabDescriptor {
  /** Stable identity: a {@link ProfileTab} name, or `lane:<laneId>`. */
  key: string;
  /** What the tab bar shows. A lane tab is labelled with the lane's own name. */
  label: string;
  /**
   * The surface this tab renders. Every lane tab renders `posts` — a lane is a
   * lens over the author's original posts — and is told apart by {@link laneId}.
   */
  tab: ProfileTab;
  /** Set on a LANE tab only: the lane whose posts the tab shows. */
  laneId?: string;
}

/** A lane as the tab strip needs it: the id it routes by and the name it shows. */
export interface LaneTabInput {
  id: string;
  name: string;
}

/** The selection key of one lane's tab. */
export function laneTabKey(laneId: string): string {
  return `lane:${laneId}`;
}

/**
 * The profile's tab strip: the static tabs this account KIND gets, with the
 * publisher's lane tabs spliced in directly AFTER `posts`.
 *
 * That position is the point of the feature — a lane is a second reading of the
 * same body of work, so it belongs beside the main tab rather than past Lists
 * where nobody scrolls. It is also exactly why `REPLIES_TAB_INDEX = 1` and
 * `BOOSTS_TAB_INDEX = 5` had to go: with one lane they name the wrong tabs.
 *
 * The kind is taken here rather than by the caller filtering afterwards, so a
 * screen cannot render a strip a channel has no business having by forgetting a
 * step — see {@link profileTabsForAccountKind} for which tabs it drops and why.
 * `labels` still covers every {@link ProfileTab}: the caller has no reason to
 * know which subset survives, and an unused label costs one `t()`.
 */
export function buildProfileTabDescriptors(
  labels: Readonly<Record<ProfileTab, string>>,
  lanes: readonly LaneTabInput[] = [],
  accountKind?: AccountKind,
): ProfileTabDescriptor[] {
  const descriptors: ProfileTabDescriptor[] = [];
  for (const tab of profileTabsForAccountKind(accountKind)) {
    descriptors.push({ key: tab, label: labels[tab], tab });
    if (tab === 'posts') {
      for (const lane of lanes) {
        descriptors.push({
          key: laneTabKey(lane.id),
          label: lane.name,
          tab: 'posts',
          laneId: lane.id,
        });
      }
    }
  }
  return descriptors;
}

/**
 * Where a tab sits in the strip right now, falling back to the first tab.
 *
 * The fallback matters twice over: a lane tab's key cannot resolve until the
 * lane list has loaded (so a deep link paints `posts` for one frame and settles
 * on the lane), and a lane deleted while somebody had its tab open resolves to
 * nothing at all rather than to a blank screen.
 */
export function profileTabIndex(
  descriptors: readonly ProfileTabDescriptor[],
  key: string,
): number {
  const index = descriptors.findIndex((descriptor) => descriptor.key === key);
  return index >= 0 ? index : 0;
}

/** Tabs backed by the post Feed and therefore owned by its virtualized list. */
export const VIRTUALIZED_PROFILE_FEED_TABS = [
  'posts',
  'replies',
  'likes',
  'boosts',
] as const satisfies readonly ProfileTab[];

export function isVirtualizedProfileFeedTab(
  tab: ProfileTab,
): tab is (typeof VIRTUALIZED_PROFILE_FEED_TABS)[number] {
  return (VIRTUALIZED_PROFILE_FEED_TABS as readonly ProfileTab[]).includes(tab);
}

export function shouldFeedOwnProfileScroll(input: {
  tab: ProfileTab;
  isWeb: boolean;
  isPrivate: boolean;
  isOwnProfile: boolean;
}): boolean {
  return (
    !input.isWeb &&
    isVirtualizedProfileFeedTab(input.tab) &&
    !(input.isPrivate && !input.isOwnProfile)
  );
}

/** Grid tabs whose rows can be bounded by the native viewport. */
export const VIRTUALIZED_PROFILE_GRID_TABS = [
  'media',
  'videos',
] as const satisfies readonly ProfileTab[];

export function isVirtualizedProfileGridTab(
  tab: ProfileTab,
): tab is (typeof VIRTUALIZED_PROFILE_GRID_TABS)[number] {
  return (VIRTUALIZED_PROFILE_GRID_TABS as readonly ProfileTab[]).includes(tab);
}

export function shouldGridOwnProfileScroll(input: {
  tab: ProfileTab;
  isWeb: boolean;
  isPrivate: boolean;
  isOwnProfile: boolean;
}): boolean {
  return (
    !input.isWeb &&
    isVirtualizedProfileGridTab(input.tab) &&
    !(input.isPrivate && !input.isOwnProfile)
  );
}

// Bottom sheet open helper from useAuth().showBottomSheet
export type ShowBottomSheetFn = NonNullable<ReturnType<typeof useAuth>['showBottomSheet']>;

// Props for the main ProfileScreen component
export interface ProfileScreenProps {
  tab?: ProfileTab;
  /**
   * Opens the profile on one lane's tab. Set only by the
   * `[username]/lane/[laneId]` route; the lane's own `displayMode` decides
   * whether that tab exists at all, so an unknown id lands on `posts`.
   */
  laneId?: string;
}

// Component props for FollowButton from @oxyhq/services
export interface FollowButtonProps {
  userId: string;
  size?: 'small' | 'medium' | 'large';
  /** Seeds the button so a followed user renders "Following" on mount (no flash). */
  initiallyFollowing?: boolean;
}

export type FollowButtonComponent = React.ComponentType<FollowButtonProps>;

// Component props for UserName
export interface UserNameProps {
  name?: string | null;
  handle?: string | null;
  verified?: boolean;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  variant?: 'default' | 'small';
  /**
   * Horizontal alignment of the stacked name row + `@handle` line. `'start'`
   * (default) keeps the left-aligned column every existing caller relies on;
   * `'center'` centers the name row (name + verified/federated/agent badges) and
   * the muted `@handle` beneath it for a classic centered profile header (used by
   * the profile About screen). Opt-in so all current callers are byte-unchanged.
   */
  align?: 'start' | 'center';
  style?: {
    name?: StyleProp<TextStyle>;
    handle?: StyleProp<TextStyle>;
    container?: StyleProp<ViewStyle>;
  };
  unifiedColors?: boolean;
  onPress?: () => void;
  /**
   * Opt-in tap-to-copy for the `@handle`. Default off so the handle stays plain
   * text inside navigable parents (e.g. who-to-follow cards), letting the parent
   * receive the tap and navigate. Only the profile header enables it.
   */
  copyableHandle?: boolean;
  /** Extra element rendered inline after the verified/federated/agent icons (name line). */
  trailingBadge?: React.ReactNode;
  /** Passive element rendered inline to the right of the `@handle` on the handle line (e.g. a "Follows you" tag). */
  handleTrailing?: React.ReactNode;
}

export type UserNameComponent = React.ComponentType<UserNameProps>;

// Profile header props (shared between default and minimalist). Only the
// minimalist header renders the name itself; the default header leaves that to
// the `UserName` block the parent renders beneath it, so the name/verified/
// component trio belongs to the minimalist contract alone.
export interface ProfileHeaderBaseProps {
  username?: string;
  avatarUri?: string;
}

export interface ProfileHeaderMinimalistProps extends ProfileHeaderBaseProps {
  displayName?: string;
  verified?: boolean;
  UserNameComponent: UserNameComponent;
  isPrivate: boolean;
  privacySettings?: ProfileData['privacy'];
  /** Drives the live-avatar swap and the presence dot; both are skipped without it. */
  profileId?: string;
  isOwnProfile?: boolean;
  /** Extra element rendered inline after the name (e.g. the fediverse badge). */
  trailingBadge?: React.ReactNode;
}

export interface ProfileHeaderDefaultProps extends ProfileHeaderBaseProps {
  isOwnProfile: boolean;
  currentUsername?: string;
  profileId?: string;
  isFederated?: boolean;
  actorUri?: string;
  isFollowing?: boolean;
  FollowButtonComponent: FollowButtonComponent;
}

// Profile stats props
export interface ProfileStatsProps {
  followingCount: number;
  followerCount: number;
  postsCount: number;
  boostsCount: number;
  repliesCount: number;
  /**
   * Whether the replies stat is shown. Follows the SAME rule as the replies TAB
   * — an account that can never author a reply has no honest replies count to
   * offer, and the stat is a jump link to a tab that would not be there. The
   * caller derives it from {@link profileTabsForAccountKind} so the two cannot
   * disagree.
   */
  showReplies?: boolean;
  profileUsername?: string;
  profileHandle?: string;
  username: string;
  onPostsPress: () => void;
  onBoostsPress: () => void;
  onRepliesPress: () => void;
}

// Profile actions props
export interface ProfileActionsProps {
  isOwnProfile: boolean;
  currentUsername?: string;
  profileUsername?: string;
  profileId?: string;
  FollowButtonComponent: FollowButtonComponent;
  showBottomSheet?: ShowBottomSheetFn;
}

// Profile meta props (location, join date)
export interface ProfileMetaProps {
  location?: string;
  createdAt?: string;
  username: string;
  profileHandle?: string;
}

// Community interface
export interface Community {
  id?: string;
  name: string;
  description?: string;
  icon?: string;
  memberCount?: number;
}

// Profile communities props
export interface ProfileCommunitiesProps {
  communities: Community[];
}

// Profile tabs content props
export interface ProfileTabsProps {
  tab: ProfileTab;
  /**
   * Present on a LANE tab: the feed is fetched by the lane's own descriptor
   * (`lane|<id>`), not as the author feed, so it must reach `<Feed>` as a filter
   * rather than as a `userId`.
   */
  laneId?: string;
  profileId?: string;
  isPrivate: boolean;
  isOwnProfile: boolean;
  isFederated?: boolean;
  actorUri?: string;
}

// Private badge props
export interface PrivateBadgeProps {
  privacySettings?: ProfileData['privacy'];
}

// Profile content (main info section) props
export interface ProfileContentProps {
  profileData: ProfileData;
  avatarUri?: string;
  isOwnProfile: boolean;
  isPrivate: boolean;
  currentUsername?: string;
  followingCount: number;
  followerCount: number;
  username: string;
  FollowButtonComponent: FollowButtonComponent;
  onPostsPress: () => void;
  onBoostsPress: () => void;
  onRepliesPress: () => void;
  onLayout?: (height: number) => void;
}

// Layout constants
export const LAYOUT = {
  HEADER_HEIGHT_EXPANDED: 120,
  HEADER_HEIGHT_NARROWED: 50,
  DEFAULT_PADDING: 16,
  SCROLL_CHECK_THROTTLE: 180,
  LOAD_MORE_THRESHOLD: 500,
  FEED_LIMIT: 20,
} as const;

// Hook return types
export interface UseSubscriptionReturn {
  subscribed: boolean;
  loading: boolean;
  toggle: () => Promise<void>;
}
