import React, { memo } from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useFollowEntity } from '@/hooks/useFollowEntity';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';

interface EntityFollowButtonProps {
  entityType: string;
  entityId: string;
  label?: string;
  followingLabel?: string;
  size?: 'sm' | 'md';
}

export const EntityFollowButton = memo(function EntityFollowButton({
  entityType,
  entityId,
  label,
  followingLabel,
  size = 'md',
}: EntityFollowButtonProps) {
  const { isFollowing, isLoading, toggle } = useFollowEntity(entityType, entityId);
  const theme = useTheme();
  const { t } = useTranslation();

  const text = isFollowing
    ? (followingLabel || t('common.following', { defaultValue: 'Following' }))
    : (label || t('common.follow', { defaultValue: 'Follow' }));

  return (
    <TouchableOpacity
      onPress={toggle}
      disabled={isLoading}
      activeOpacity={0.8}
      style={[
        styles.button,
        size === 'sm' && styles.buttonSmall,
        {
          backgroundColor: isFollowing ? theme.colors.background : theme.colors.primary,
          borderColor: isFollowing ? theme.colors.border : theme.colors.primary,
        },
      ]}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color={isFollowing ? theme.colors.text : '#fff'} />
      ) : (
        <Text
          style={[
            styles.text,
            size === 'sm' && styles.textSmall,
            { color: isFollowing ? theme.colors.text : '#fff' },
          ]}
        >
          {text}
        </Text>
      )}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 35,
    paddingVertical: 6,
    paddingHorizontal: 16,
    minWidth: 80,
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
    paddingVertical: 4,
    paddingHorizontal: 12,
    minWidth: 60,
  },
  text: {
    fontWeight: '600',
    fontSize: 14,
  },
  textSmall: {
    fontSize: 12,
  },
});

export default EntityFollowButton;
