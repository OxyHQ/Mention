import type { ViewStyle, TextStyle, StyleProp } from 'react-native';
import type { ProfileData } from '@/hooks/useProfileData';

/**
 * Profile Screen Types
 * Centralized type definitions following industry standards
 */

import type { useAuth } from '@oxyhq/services/ui/client';

// Tab configuration
export const TAB_NAMES = ['posts', 'replies', 'media', 'videos', 'likes', 'boosts', 'feeds', 'starter_packs', 'lists'] as const;
export type ProfileTab = typeof TAB_NAMES[number];

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

export interface UseProfileScrollReturn {
  scrollY: any; // Animated.Value type from useLayoutScroll
  scrollRef: React.RefObject<any>;
  onScroll: any; // Animated scroll handler
  assignScrollRef: (node: any) => void;
  scrollToContent: (offset: number) => void;
}
