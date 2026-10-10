import { memo } from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { FeedType } from '@mention/shared-types';
import type { FeedFailureKind } from '@/utils/feedRetry';
import { EmptyState } from '@/components/common/EmptyState';
import { Loading } from '@oxy.so/bloom/loading';
import type { EmptyStateStickerName } from '@/lib/stickers';

interface FeedEmptyStateProps {
  isLoading: boolean;
  error: string | null;
  /**
   * What kind of failure `error` was. Only `offline` changes what the reader
   * is told — retrying is futile until the connection is back, and they are
   * the one who can fix it. Everything else reads as a passing hiccup.
   */
  errorKind?: FeedFailureKind | null;
  hasItems: boolean;
  type: FeedType;
  onRetry?: () => Promise<void>;
  /**
   * True while a federated profile feed is still populating in the background
   * (auto-refetching). Shows a loading state instead of the empty placeholder.
   */
  pending?: boolean;
  /** A `replies` feed that is one thread's replies, not a profile's Replies tab. */
  isThread?: boolean;
}

/**
 * Feed empty state component
 * Handles loading, error, and empty states
 */
export const FeedEmptyState = memo<FeedEmptyStateProps>(
  ({ isLoading, error, errorKind, hasItems, type, onRetry, pending, isThread }) => {
    const { t } = useTranslation();
    if (isLoading || pending)
      return (
        <View className="items-center justify-center py-12 gap-3">
          <Loading iconSize={28} style={{ padding: 0 }} />
          {pending && (
            <Text className="text-muted-foreground text-sm">
              {t('feed.loadingPosts', { defaultValue: 'Loading posts…' })}
            </Text>
          )}
        </View>
      );

    const hasError = !!error;
    const hasNoItems = !hasItems;

    // A feed that failed with nothing to show. By the time this renders the
    // read has already been retried and given up (`utils/feedRetry`), and
    // `isLoading` covered every attempt above — so a transient backend blip
    // never gets this far while a retry is still pending.
    //
    // Deliberately quiet: the title and the Try again button, with no
    // alarm-red icon disc, because "the server had a moment" is not the
    // reader's problem to solve. An OFFLINE device is the exception — that
    // one they can act on, so it keeps the connection icon and says so.
    if (hasError && hasNoItems && onRetry) {
      const isOffline = errorKind === 'offline';
      return (
        <EmptyState
          error={{
            title: t('feed.empty.title'),
            message: isOffline
              ? t('No connection. Check your network and try again.', {
                  defaultValue: 'No connection. Check your network and try again.',
                })
              : t('feed.empty.message'),
            onRetry,
          }}
          icon={isOffline ? { name: 'cloud-offline-outline', size: 36 } : undefined}
        />
      );
    }

    const copy = emptyCopy(t, type, { isThread });
    return (
      <EmptyState
        title={copy.title}
        subtitle={copy.subtitle}
        sticker={emptySticker(type, { isThread })}
      />
    );
  },
);

FeedEmptyState.displayName = 'FeedEmptyState';

/**
 * Which catalogue sticker an empty feed shows, per kind of feed — chosen with
 * the same cases as {@link emptyCopy}, so a feed's picture and its words agree.
 * Names resolve in `lib/stickers.ts`.
 */
export function emptySticker(
  type: FeedType,
  { isThread }: { isThread?: boolean } = {},
): EmptyStateStickerName {
  switch (type) {
    case 'posts':
      return 'profilePosts';
    case 'media':
      return 'profileMedia';
    case 'videos':
      return 'profileVideos';
    case 'replies':
      return isThread ? 'threadNoReplies' : 'profileReplies';
    case 'boosts':
      return 'profileBoosts';
    case 'mentions':
      return 'profileMentions';
    case 'likes':
      return 'profileLikes';
    case 'explore':
      return 'feedExplore';
    case 'for_you':
      return 'feedForYou';
    case 'hashtag':
      return 'feedHashtag';
    case 'custom':
      return 'feedCustom';
    case 'saved':
      return 'saved';
    default:
      return 'feedFollowing';
  }
}

type Translate = ReturnType<typeof useTranslation>['t'];

/**
 * What an empty feed says, as ONE title and subtitle pair per kind of feed.
 *
 * The title used to be "No posts yet" for every feed and only the subtitle
 * varied, so a thread with no replies read "No posts yet" over "No replies yet.
 * Be the first to reply!" — two headlines contradicting each other, in English
 * only (OxyHQ/Mention#1140). Each pair is written together now, and translated.
 * A thread's replies and a profile's Replies tab are both `replies` feeds, and
 * only the thread can invite a reply.
 */
export function emptyCopy(
  t: Translate,
  type: FeedType,
  { isThread }: { isThread?: boolean } = {},
): { title: string; subtitle: string } {
  switch (type) {
    case 'posts':
      return {
        title: t('feed.emptyState.posts.title'),
        subtitle: t('feed.emptyState.posts.subtitle'),
      };
    case 'media':
      return {
        title: t('feed.emptyState.media.title'),
        subtitle: t('feed.emptyState.media.subtitle'),
      };
    case 'replies':
      return isThread
        ? {
            title: t('feed.emptyState.thread.title'),
            subtitle: t('feed.emptyState.thread.subtitle'),
          }
        : {
            title: t('feed.emptyState.replies.title'),
            subtitle: t('feed.emptyState.replies.subtitle'),
          };
    case 'boosts':
      return {
        title: t('feed.emptyState.boosts.title'),
        subtitle: t('feed.emptyState.boosts.subtitle'),
      };
    case 'mentions':
      return {
        title: t('feed.emptyState.mentions.title'),
        subtitle: t('feed.emptyState.mentions.subtitle'),
      };
    case 'likes':
      return {
        title: t('feed.emptyState.likes.title'),
        subtitle: t('feed.emptyState.likes.subtitle'),
      };
    case 'explore':
      return {
        title: t('feed.emptyState.explore.title'),
        subtitle: t('feed.emptyState.explore.subtitle'),
      };
    case 'for_you':
      return {
        title: t('feed.emptyState.forYou.title'),
        subtitle: t('feed.emptyState.forYou.subtitle'),
      };
    case 'custom':
      return {
        title: t('feed.emptyState.custom.title'),
        subtitle: t('feed.emptyState.custom.subtitle'),
      };
    case 'saved':
      return {
        title: t('feed.emptyState.saved.title'),
        subtitle: t('feed.emptyState.saved.subtitle'),
      };
    default:
      return {
        title: t('feed.emptyState.following.title'),
        subtitle: t('feed.emptyState.following.subtitle'),
      };
  }
}
