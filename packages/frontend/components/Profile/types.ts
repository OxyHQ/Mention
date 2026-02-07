import type { ViewStyle, TextStyle, StyleProp } from 'react-native';
import type { ProfileData } from '@/hooks/useProfileData';

/**
 * Profile Screen Types
 * Centralized type definitions following industry standards
 */

// Tab configuration
export const TAB_NAMES = ['posts', 'replies', 'media', 'videos', 'likes', 'reposts'] as const;
export type ProfileTab = typeof TAB_NAMES[number];

// Props for the main ProfileScreen component
export interface ProfileScreenProps {
  tab?: ProfileTab;
}

// Theme colors interface (subset of full theme)
export interface ThemeColors {
  text: string;
  textSecondary: string;
  background: string;
  backgroundSecondary: string;
  primary: string;
  border: string;
}

export interface Theme {
  colors: ThemeColors;
  isDark: boolean;
}

// Component props for FollowButton from @oxyhq/services
export interface FollowButtonProps {
  userId: string;
  size?: 'small' | 'medium' | 'large';
}

export type FollowButtonComponent = React.ComponentType<FollowButtonProps>;

// Component props for UserName
export interface UserNameProps {
  name?: string | null;
  handle?: string;
  verified?: boolean;
  variant?: 'default' | 'small';
  style?: {
    name?: StyleProp<TextStyle>;
    handle?: StyleProp<TextStyle>;
    container?: StyleProp<ViewStyle>;
  };
  unifiedColors?: boolean;
}

export type UserNameComponent = React.ComponentType<UserNameProps>;

// Profile header props (shared between default and minimalist)
export interface ProfileHeaderBaseProps {
  displayName: string;
  username?: string;
  avatarUri?: string;
  verified?: boolean;
  theme: Theme;
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
  FollowButtonComponent: FollowButtonComponent;
  showBottomSheet?: (sheet: string) => void;
}

// Profile stats props
export interface ProfileStatsProps {
  followingCount: number;
  followerCount: number;
  postsCount: number;
  profileUsername?: string;
  username: string;
  onPostsPress: () => void;
}

// Profile actions props
export interface ProfileActionsProps {
  isOwnProfile: boolean;
  currentUsername?: string;
  profileUsername?: string;
  profileId?: string;
  FollowButtonComponent: FollowButtonComponent;
  showBottomSheet?: (sheet: string) => void;
}

// Profile meta props (location, links, join date)
export interface ProfileMetaProps {
  location?: string;
  links?: string[];
  createdAt?: string;
  username: string;
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
  showBottomSheet?: (sheet: string) => void;
  onPostsPress: () => void;
  onLayout?: (height: number) => void;
}

// Layout constants
export const LAYOUT = {
  HEADER_HEIGHT_EXPANDED: 120,
  HEADER_HEIGHT_NARROWED: 50,
  DEFAULT_PADDING: 16,
  FAB_BOTTOM_MARGIN: 24,
  FAB_RIGHT_MARGIN: 24,
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

