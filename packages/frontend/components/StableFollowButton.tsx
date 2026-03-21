/**
 * StableFollowButton — A follow button designed for list contexts (e.g. followers/following pages)
 * where many instances are rendered simultaneously.
 *
 * The FollowButton from @oxyhq/services subscribes to the entire follow store via
 * `useFollowStore()` (no selector). In a list of N users, every store update causes
 * all N buttons to re-render, and each re-render creates a new `fetchStatus` callback
 * reference (because it depends on the full store), which triggers the mount useEffect
 * again, creating an infinite fetch→update→re-render loop that freezes the app.
 *
 * This component avoids the problem by:
 * 1. Managing follow state locally per-instance (no shared store subscription)
 * 2. Not auto-fetching follow status on mount (fetches once, then uses local state)
 * 3. Using `React.memo` so parent re-renders don't cascade
 */
import React, { useCallback, useState, useEffect, useRef, memo } from 'react';
import {
  TouchableOpacity,
  Text,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';

interface StableFollowButtonProps {
  userId: string;
  size?: 'small' | 'medium' | 'large';
}

/**
 * Inner component that renders only when we know we should show the button.
 * Separating this avoids a Rules of Hooks violation (the library FollowButton
 * has an early return before hooks, which can crash).
 */
const StableFollowButtonInner = memo(function StableFollowButtonInner({
  userId,
  size = 'small',
}: StableFollowButtonProps) {
  const { oxyServices } = useAuth();
  const theme = useTheme();
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  // Fetch follow status once on mount — no dependency on shared store
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    oxyServices.getFollowStatus(userId)
      .then((response: { isFollowing: boolean }) => {
        if (!cancelled && mountedRef.current) {
          setIsFollowing(response.isFollowing);
        }
      })
      .catch(() => {
        // Silently ignore — button will show "Follow" by default
      });

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [userId, oxyServices]);

  const handlePress = useCallback(async () => {
    if (loading) return;
    setLoading(true);

    const wasFollowing = isFollowing;
    // Optimistic update
    setIsFollowing(!wasFollowing);

    try {
      if (wasFollowing) {
        await oxyServices.unfollowUser(userId);
      } else {
        await oxyServices.followUser(userId);
      }
    } catch {
      // Revert on failure
      if (mountedRef.current) {
        setIsFollowing(wasFollowing);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [userId, oxyServices, loading, isFollowing]);

  const buttonStyle = [
    styles.button,
    size === 'small' && styles.buttonSmall,
    size === 'large' && styles.buttonLarge,
    {
      backgroundColor: isFollowing ? theme.colors.primary : theme.colors.background,
      borderColor: isFollowing ? theme.colors.primary : theme.colors.border,
    },
  ];

  const textStyle = [
    styles.text,
    size === 'small' && styles.textSmall,
    size === 'large' && styles.textLarge,
    { color: isFollowing ? '#FFFFFF' : theme.colors.text },
  ];

  return (
    <TouchableOpacity
      style={buttonStyle}
      onPress={handlePress}
      disabled={loading}
      activeOpacity={0.8}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={isFollowing ? '#FFFFFF' : theme.colors.primary}
        />
      ) : (
        <Text style={textStyle}>
          {isFollowing ? 'Following' : 'Follow'}
        </Text>
      )}
    </TouchableOpacity>
  );
});

/**
 * Outer wrapper that handles the "should we render?" check before any hooks
 * in the inner component are called, avoiding Rules of Hooks violations.
 */
const StableFollowButton = memo(function StableFollowButton({
  userId,
  size = 'small',
}: StableFollowButtonProps) {
  const { user: currentUser, isAuthenticated } = useAuth();

  const currentUserId = currentUser?.id ? String(currentUser.id).trim() : '';
  const targetUserId = userId ? String(userId).trim() : '';

  if (!isAuthenticated || !targetUserId || (currentUserId && currentUserId === targetUserId)) {
    return null;
  }

  return <StableFollowButtonInner userId={targetUserId} size={size} />;
});

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 35,
    // Default (medium) sizing
    paddingVertical: 8,
    paddingHorizontal: 16,
    minWidth: 90,
    ...Platform.select({
      web: {},
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 2,
      },
    }),
  },
  buttonSmall: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    minWidth: 70,
  },
  buttonLarge: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    minWidth: 120,
  },
  text: {
    fontWeight: '600',
    fontSize: 15,
  },
  textSmall: {
    fontSize: 13,
  },
  textLarge: {
    fontSize: 16,
  },
});

export { StableFollowButton };
export default StableFollowButton;
