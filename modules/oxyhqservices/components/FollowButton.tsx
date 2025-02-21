import React, { useState, useEffect, useRef } from 'react';
import { TouchableOpacity, ActivityIndicator, Text, StyleSheet, Animated, GestureResponderEvent } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/modules/oxyhqservices/hooks/useProfile';
import { useDispatch, useSelector } from 'react-redux';
import { addFollowing, removeFollowing } from '@/store/reducers/followReducer';
import type { RootState } from '@/store/store';

interface FollowButtonProps {
  userId: string;
  initialIsFollowing?: boolean;
  onFollowStatusChange?: (isFollowing: boolean) => void;
}

export const FollowButton: React.FC<FollowButtonProps> = ({
  userId,
  onFollowStatusChange
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const { user: currentUser } = useAuth();
  const { followUser, unfollowUser, getFollowingStatus, loading, error } = useProfile();
  const buttonWidth = useRef(new Animated.Value(100)).current;
  const dispatch = useDispatch();
  
  const isFollowing = useSelector((state: RootState) => 
    state.follow.followingIds.includes(userId)
  );

  useEffect(() => {
    const checkFollowStatus = async () => {
      if (currentUser?.id === userId) return;
      const status = await getFollowingStatus(userId);
      if (status) {
        dispatch(addFollowing(userId));
      }
      setIsLoading(false);
      animateButton(status ? 'following' : 'follow');
    };

    checkFollowStatus();
  }, [userId, currentUser?.id, dispatch]);

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
    if (!currentUser || isLoading || currentUser.id === userId) return;

    setIsLoading(true);
    animateButton('loading');

    try {
      const success = isFollowing
        ? await unfollowUser(userId)
        : await followUser(userId);

      if (success) {
        const newState = !isFollowing;
        if (newState) {
          dispatch(addFollowing(userId));
        } else {
          dispatch(removeFollowing(userId));
        }
        animateButton(newState ? 'following' : 'follow');
        onFollowStatusChange?.(newState);
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (currentUser?.id === userId) return null;

  return (
    <TouchableOpacity 
      style={styles.container}
      onPress={handlePress}
      disabled={isLoading}
    >
      <Animated.View style={[
        styles.defaultFollowButton,
        isFollowing ? styles.followingButton : styles.followButton,
        { width: buttonWidth }
      ]}>
        {isLoading ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Text style={styles.followButtonText}>
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
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: "black",
    overflow: "hidden",
    borderWidth: 2,
    borderColor: "black",
    alignItems: "center",
    justifyContent: "center",
  },
  followButton: {
  },
  followingButton: {
  },
  followButtonText: {
    color: "white",
    fontWeight: "bold",
    fontSize: 16,
  },
  followingButtonText: {
    color: "white",
  },
});
