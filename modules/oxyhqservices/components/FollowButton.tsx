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
  const buttonWidth = useRef(new Animated.Value(100)).current;
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
    const widthValue = state === 'loading' ? 40 :
      state === 'following' ? 100 :
        80;

    Animated.spring(buttonWidth, {
      toValue: widthValue,
      useNativeDriver: false,
      friction: 7,
      tension: 40
    }).start();
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

      // Update parent component
      onFollowStatusChange?.(newFollowState);

      // Animate after state update
      animateButton(newFollowState ? 'following' : 'follow');
    } catch (error) {
      console.error('Error toggling follow status:', error);
      // Revert animation on error
      animateButton(isFollowing ? 'following' : 'follow');
      toast.error('Failed to update follow status. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const buttonDisabled = isLoading || followLoading || !isAuthenticated || currentUser?.id === userId;

  if (!isAuthenticated || currentUser?.id === userId) return null;

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={handlePress}
      disabled={buttonDisabled}
    >
      <Animated.View style={[
        styles.defaultFollowButton,
        isFollowing ? styles.followingButton : styles.followButton,
        buttonDisabled && styles.disabledButton,
        { width: buttonWidth }
      ]}>
        {(isLoading || followLoading) ? (
          <ActivityIndicator
            size="small"
            color={isFollowing ? colors.COLOR_BLACK_LIGHT_4 : "#ffffff"}
          />
        ) : (
          <Text style={[
            styles.followButtonText,
            isFollowing ? styles.followingButtonText : null,
            buttonDisabled && styles.disabledText
          ]}>
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
  } as any,
  followingButtonText: {
    color: colors.COLOR_BLACK_LIGHT_4,
  } as any,
  disabledText: {
    opacity: 0.6,
  } as any,
});
