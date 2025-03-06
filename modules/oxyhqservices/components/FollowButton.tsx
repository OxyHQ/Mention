import React, { useState, useEffect, useRef } from 'react';
import { TouchableOpacity, ActivityIndicator, Text, StyleSheet, Animated, GestureResponderEvent } from 'react-native';
import { useAuth } from '@/modules/oxyhqservices/hooks';
import { useProfile } from '@/modules/oxyhqservices/hooks/useProfile';
import { useDispatch, useSelector } from 'react-redux';
import { followUser as followUserAction, unfollowUser as unfollowUserAction, checkFollowStatus } from '@/store/reducers/followReducer';
import type { RootState, AppDispatch } from '@/store/store';
import { colors } from '@/styles/colors';
import { toast } from 'sonner';

interface FollowButtonProps {
  userId: string;
  onFollowStatusChange?: (isFollowing: boolean) => void;
}

export const FollowButton: React.FC<FollowButtonProps> = ({
  userId,
  onFollowStatusChange
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const { user: currentUser, isAuthenticated } = useAuth();
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;
  const dispatch = useDispatch<AppDispatch>();

  const isFollowing = useSelector((state: RootState) =>
    state.follow.followingIds.includes(userId)
  );

  const followLoading = useSelector((state: RootState) =>
    state.follow.loading.follow || state.follow.loading.status
  );

  useEffect(() => {
    const checkStatus = async () => {
      if (!isAuthenticated || !currentUser || currentUser.id === userId) return;

      try {
        setIsLoading(true);
        await dispatch(checkFollowStatus(userId)).unwrap();
      } catch (error) {
        console.error('Error checking follow status:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkStatus();
  }, [userId, currentUser?.id, isAuthenticated, dispatch]);

  useEffect(() => {
    if (!isLoading && !followLoading) {
      animateButton(isFollowing ? 'following' : 'follow');
    }
  }, [isFollowing, isLoading, followLoading]);

  const animateButton = (state: 'follow' | 'following' | 'loading') => {
    // Use width animation without native driver (layout property)
    const widthValue = state === 'loading' ? 40 : state === 'following' ? 100 : 80;

    // Use scale and opacity with native driver
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: state === 'loading' ? 0.95 : 1,
        useNativeDriver: true,
        friction: 7,
        tension: 40
      }),
      Animated.spring(opacityAnim, {
        toValue: state === 'loading' ? 0.8 : 1,
        useNativeDriver: true,
        friction: 7,
        tension: 40
      })
    ]).start();
  };

  const handlePress = async (event: GestureResponderEvent) => {
    event.stopPropagation();
    event.preventDefault();

    if (!isAuthenticated || !currentUser || isLoading || currentUser.id === userId) {
      return;
    }

    try {
      setIsLoading(true);
      animateButton('loading');

      const result = await dispatch(followUserAction(userId)).unwrap();
      const newFollowState = result.action === 'follow';

      onFollowStatusChange?.(newFollowState);
      animateButton(newFollowState ? 'following' : 'follow');
    } catch (error) {
      console.error('Error toggling follow status:', error);
      animateButton(isFollowing ? 'following' : 'follow');
      toast.error('Failed to update follow status');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={!isAuthenticated || isLoading || currentUser?.id === userId}
      style={styles.container}
    >
      <Animated.View
        style={[
          styles.defaultFollowButton,
          isFollowing ? styles.followingButton : styles.followButton,
          {
            opacity: opacityAnim,
            transform: [{ scale: scaleAnim }]
          }
        ]}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={isFollowing ? colors.COLOR_BLACK_LIGHT_4 : '#fff'} />
        ) : (
          <Text
            style={[
              styles.followButtonText,
              isFollowing && styles.followingButtonText
            ]}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </Text>
        )}
      </Animated.View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultFollowButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: colors.primaryColor,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.primaryColor,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 36,
  },
  followButton: {
    backgroundColor: colors.primaryColor,
  },
  followingButton: {
    backgroundColor: 'transparent',
    borderColor: colors.COLOR_BLACK_LIGHT_4,
  },
  disabledButton: {
    opacity: 0.6,
  },
  followButtonText: {
    color: "white",
    fontWeight: "600",
    fontSize: 14,
  },
  followingButtonText: {
    color: colors.COLOR_BLACK_LIGHT_4,
  }
});
