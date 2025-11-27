import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { SkeletonCircle, SkeletonText, SkeletonPill } from '@/components/Skeleton';
import { LAYOUT } from './types';

/**
 * Loading skeleton for profile screen
 * Uses static imports for better performance
 */
export const ProfileSkeleton = memo(function ProfileSkeleton() {
  const theme = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.banner, { backgroundColor: theme.colors.backgroundSecondary }]} />
      <View style={styles.content}>
        <View style={styles.avatarRow}>
          <SkeletonCircle size={90} style={[styles.avatarSkeleton, { borderColor: theme.colors.background }]} />
          <View style={styles.spacer} />
          <SkeletonPill size={36} style={styles.buttonSkeleton} />
          <SkeletonCircle size={36} />
        </View>
        <SkeletonText style={styles.nameSkeleton} />
        <SkeletonText style={styles.handleSkeleton} />
        <SkeletonText style={styles.bioLine1} />
        <SkeletonText style={styles.bioLine2} />
        <View style={styles.metaRow}>
          <SkeletonPill size={24} style={styles.metaItem1} />
          <SkeletonPill size={24} style={styles.metaItem2} />
          <SkeletonPill size={24} style={styles.metaItem3} />
        </View>
        <View style={[styles.tabs, { borderColor: theme.colors.border }]}>
          {[0, 1, 2, 3, 4].map((i) => (
            <SkeletonPill key={i} size={32} style={styles.tabItem} />
          ))}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  banner: {
    height: 150,
  },
  content: {
    paddingHorizontal: LAYOUT.DEFAULT_PADDING,
    marginTop: 16,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: -40,
  },
  avatarSkeleton: {
    borderWidth: 3,
  },
  spacer: {
    flex: 1,
  },
  buttonSkeleton: {
    width: 100,
    height: 36,
    marginRight: 8,
  },
  nameSkeleton: {
    width: '40%',
    fontSize: 20,
    marginTop: 12,
  },
  handleSkeleton: {
    width: '30%',
    fontSize: 14,
    marginTop: 8,
  },
  bioLine1: {
    width: '90%',
    fontSize: 14,
    marginTop: 12,
  },
  bioLine2: {
    width: '80%',
    fontSize: 14,
    marginTop: 8,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  metaItem1: {
    width: 120,
    height: 24,
  },
  metaItem2: {
    width: 160,
    height: 24,
  },
  metaItem3: {
    width: 180,
    height: 24,
  },
  tabs: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  tabItem: {
    width: 60,
    height: 32,
  },
});


