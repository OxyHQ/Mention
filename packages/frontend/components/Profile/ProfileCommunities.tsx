import React, { memo } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import type { ProfileCommunitiesProps, Community } from './types';

/**
 * Profile communities section
 * Displays communities the user is a member of
 */
export const ProfileCommunities = memo(function ProfileCommunities({
  communities,
}: ProfileCommunitiesProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  if (!communities || communities.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: theme.colors.text }]}>
        {t('profile.communities')}
      </Text>
      {communities.map((community, index) => (
        <CommunityCard key={community.id || index} community={community} />
      ))}
    </View>
  );
});

const CommunityCard = memo(function CommunityCard({ community }: { community: Community }) {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.backgroundSecondary,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <View style={styles.header}>
        {community.icon && (
          <View style={styles.iconContainer}>
            <Image
              source={{ uri: community.icon }}
              resizeMode="cover"
              style={styles.iconImage}
            />
          </View>
        )}
        <View style={styles.info}>
          <Text style={[styles.name, { color: theme.colors.text }]}>
            {community.name}
          </Text>
          {community.description && (
            <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
              {community.description}
            </Text>
          )}
          {community.memberCount && (
            <View style={styles.members}>
              <Text style={[styles.memberCount, { color: theme.colors.textSecondary }]}>
                {t('profile.memberCount', {
                  count: community.memberCount,
                  defaultValue: `${community.memberCount} Members`,
                })}
              </Text>
            </View>
          )}
        </View>
      </View>
      <TouchableOpacity style={styles.viewButton}>
        <Text style={[styles.viewButtonText, { color: theme.colors.primary }]}>
          {t('profile.view')}
        </Text>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginTop: 16,
  },
  title: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  card: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
  },
  header: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  iconContainer: {
    width: 100,
    height: 100,
    borderRadius: 8,
    marginRight: 12,
    overflow: 'hidden',
  },
  iconImage: {
    flex: 1,
    overflow: 'hidden',
  },
  info: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  description: {
    fontSize: 14,
    lineHeight: 18,
    marginBottom: 8,
  },
  members: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  memberCount: {
    fontSize: 13,
  },
  viewButton: {
    backgroundColor: 'transparent',
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignSelf: 'center',
    width: '100%',
    marginTop: 10,
  },
  viewButtonText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
});




