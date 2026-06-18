/**
 * StableFollowButton — A follow button designed for list contexts (e.g. followers/following pages)
 * where many instances are rendered simultaneously.
 *
 * Key design decisions to prevent freezes:
 * 1. Uses the singleton oxyServices import instead of useAuth() context — context changes
 *    (session socket, token refresh) would bypass React.memo and re-render ALL N buttons.
 * 2. Manages follow state locally per-instance (no shared store subscription).
 * 3. Fetches follow status once on mount with cleanup to prevent stale updates.
 */
import React, { useCallback, useState, useEffect, useRef, memo } from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  Platform,
} from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@oxyhq/bloom/theme';
import type { OxyServices } from '@oxyhq/core';

interface StableFollowButtonProps {
  userId: string;
  size?: 'small' | 'medium' | 'large';
}

interface StableFollowButtonInnerProps extends StableFollowButtonProps {
  /**
   * The current viewer's id, forwarded from the outer wrapper (which already
   * subscribes to OxyContext). Passing it as a prop — rather than calling
   * useAuth() here — keeps the inner component free of the context
   * subscription that would re-render all N buttons on every token refresh,
   * while still letting the follow-status fetch re-run when the viewer's
   * session resolves or switches on cold boot.
   */
  viewerId: string;
  oxyServices: OxyServices;
}

/**
 * Inner component that renders only when we know we should show the button.
 * Separating this avoids a Rules of Hooks violation (the library FollowButton
 * has an early return before hooks, which can crash).
 *
 * Uses the module-level oxyServices singleton to avoid subscribing to OxyContext.
 * This is critical: useAuth() subscribes to context, and context changes (e.g. session
 * socket events, token refreshes) bypass React.memo, causing all N buttons to re-render
 * simultaneously and freezing the UI.
 */
const StableFollowButtonInner = memo(function StableFollowButtonInner({
  userId,
  viewerId,
  oxyServices,
  size = 'small',
}: StableFollowButtonInnerProps) {
  const theme = useTheme();
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  // Fetch follow status when the target or the viewer changes. Follow state is
  // per-viewer, so on cold boot it must re-run once the viewer's session
  // resolves (and again if the active account switches) — keying on `userId`
  // alone would otherwise snapshot the anonymous result and never refresh.
  // `viewerId` only changes on a real identity change, so this does not thrash
  // the optimistic follow/unfollow state set by handlePress.
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
  }, [oxyServices, userId, viewerId]);

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
  }, [oxyServices, userId, loading, isFollowing]);

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
        <SpinnerIcon size={16} className={isFollowing ? "text-primary-foreground" : "text-primary"} />
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
 *
 * This is the only place we use useAuth() — to check if the user is authenticated
 * and to get their ID for the self-follow guard. The inner component avoids context
 * subscriptions entirely.
 */
const StableFollowButton = memo(function StableFollowButton({
  userId,
  size = 'small',
}: StableFollowButtonProps) {
  const { user: currentUser, isAuthenticated, oxyServices } = useAuth();

  const currentUserId = currentUser?.id ? String(currentUser.id).trim() : '';
  const targetUserId = userId ? String(userId).trim() : '';

  if (!isAuthenticated || !targetUserId || (currentUserId && currentUserId === targetUserId)) {
    return null;
  }

  return <StableFollowButtonInner userId={targetUserId} viewerId={currentUserId} oxyServices={oxyServices} size={size} />;
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
