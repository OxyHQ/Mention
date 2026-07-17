import type { ViewStyle, TextStyle, StyleProp } from 'react-native';
import type { ProfileData } from '@/hooks/useProfileData';

/**
 * Profile Screen Types
 * Centralized type definitions following industry standards
 */

import type { useAuth } from '@oxyhq/services';

// Tab configuration
export const TAB_NAMES = ['posts', 'replies', 'media', 'videos', 'likes', 'boosts', 'feeds', 'starter_packs', 'lists'] as const;
export type ProfileTab = typeof TAB_NAMES[number];

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

// Profile header props (shared between default and minimalist)
export interface ProfileHeaderBaseProps {
  displayName?: string;
  username?: string;
  avatarUri?: string;
  verified?: boolean;
  UserNameComponent: UserNameComponent;
}

export interface ProfileHeaderMinimalistProps extends ProfileHeaderBaseProps {
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
  isFollowPending?: boolean;
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

// Skeleton props
export interface ProfileSkeletonProps {
  // No props needed, uses theme internally
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
