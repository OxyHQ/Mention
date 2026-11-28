// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';

interface FeedFooterProps {
  hasMore: boolean;
  isLoadingMore: boolean;
  hasItems: boolean;
  /** The next page failed to load; rows on screen are kept and the reader can ask again. */
  loadFailed?: boolean;
  onRetryLoadMore?: () => void;
  /**
   * The feed loads its next page when asked, not when its end is reached (a
   * minor's account, oxy ADR 0068): offer the page instead of fetching it.
   */
  loadOnRequest?: boolean;
  /** A home timeline has been read to its end: say so, instead of just stopping. */
  caughtUp?: boolean;
}

/**
 * Feed footer component
 * Displays loading indicator when loading more items
 * Offers to load again when the next page failed, so a failed page is not a
 * feed that silently ends
 * Shows sign-in prompt for unauthenticated users
 * Offers the next page on a feed that loads on request
 * Says "you're all caught up" at the end of a home timeline
 */
export const FeedFooter = memo<FeedFooterProps>(
  ({ hasMore, isLoadingMore, hasItems, loadFailed, onRetryLoadMore, loadOnRequest, caughtUp }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const { isAuthenticated, isAuthResolved, signIn } = useAuth();

    const handleSignIn = useCallback(() => {
      signIn().catch(() => {});
    }, [signIn]);

    // Show sign-in prompt for unauthenticated users at the end of the feed.
    // Gate on isAuthResolved so the prompt never appears during the cold-boot
    // restore window (when `isAuthenticated: false` is still UNDETERMINED).
    if (isAuthResolved && !isAuthenticated && hasItems) {
      return (
        <TouchableOpacity
          className="flex-row items-center justify-center py-4 px-5 border-border"
          style={styles.signInFooter}
          onPress={handleSignIn}
          activeOpacity={0.7}
        >
          <RiLockLine size="md" fill={theme.colors.primary} />
          <Text
            className="text-foreground text-[15px] font-medium flex-1"
            style={{ marginLeft: 10 }}
          >
            Sign in to see more
          </Text>
          <RiArrowRightSLine width={18} height={18} fill={theme.colors.textSecondary} />
        </TouchableOpacity>
      );
    }

    if (loadFailed && hasMore && hasItems && onRetryLoadMore) {
      return (
        <View className="items-center py-4">
          <Button appearance="subtle" tone="neutral" onPress={onRetryLoadMore}>
            {t('common.loadMore')}
          </Button>
        </View>
      );
    }

    if (loadOnRequest && hasMore && hasItems && !isLoadingMore && onRetryLoadMore) {
      return (
        <View className="items-center py-4">
          <Button appearance="subtle" tone="neutral" onPress={onRetryLoadMore}>
            {t('common.loadMore')}
          </Button>
        </View>
      );
    }

    if (caughtUp && hasItems && !hasMore) {
      return (
        <View className="items-center py-6 px-5">
          <Text className="text-muted-foreground text-[15px] text-center">
            {t('feed.caughtUp')}
          </Text>
        </View>
      );
    }

    if (!hasMore || !isLoadingMore) return null;
    if (!hasItems) return null;

    return <FeedSkeleton count={2} />;
  },
);

FeedFooter.displayName = 'FeedFooter';

const styles = StyleSheet.create({
  signInFooter: {
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
