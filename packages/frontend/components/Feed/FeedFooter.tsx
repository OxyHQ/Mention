import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback } from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { createTokenStyles } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  Button as LButton,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
    const footerTokens = useFooterTokens();
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
          style={[styles.signInFooter, footerTokens.rule]}
          onPress={handleSignIn}
          activeOpacity={0.7}
        >
          {toElement(Icon(RiLockLine).size('md').foreground('primary'))}
          {toElement(
            RawText('Sign in to see more')
              .foreground('foreground')
              .font('md')
              .weight('medium')
              .flex('1')
              .margin('left', '10'),
          )}
          {toElement(Icon(RiArrowRightSLine).size('18').foreground('muted'))}
        </TouchableOpacity>
      );
    }

    if (loadFailed && hasMore && hasItems && onRetryLoadMore) {
      return toElement(
        VStack(
          LButton(LText(t('common.loadMore')))
            .style('subtle')
            .tint('neutral')
            .onPress(onRetryLoadMore),
        )
          .padding('vertical', 'lg')
          .align('center'),
      );
    }

    if (loadOnRequest && hasMore && hasItems && !isLoadingMore && onRetryLoadMore) {
      return toElement(
        VStack(
          LButton(LText(t('common.loadMore')))
            .style('subtle')
            .tint('neutral')
            .onPress(onRetryLoadMore),
        )
          .padding('vertical', 'lg')
          .align('center'),
      );
    }

    if (caughtUp && hasItems && !hasMore) {
      return toElement(
        VStack(RawText(t('feed.caughtUp')).foreground('muted').font('md').textAlign('center'))
          .padding('vertical', '2xl')
          .padding('horizontal', 'xl')
          .align('center'),
      );
    }

    if (!hasMore || !isLoadingMore) return null;
    if (!hasItems) return null;

    return <FeedSkeleton count={2} />;
  },
);

FeedFooter.displayName = 'FeedFooter';

const styles = StyleSheet.create({
  // A touchable row (it dims under the finger, which the language's press
  // variant has no timed opacity for).
  signInFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});

const useFooterTokens = createTokenStyles((t) => ({ rule: { borderColor: t.border } }));
