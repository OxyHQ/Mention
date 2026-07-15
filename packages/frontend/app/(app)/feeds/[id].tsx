import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
  ScrollView,
  Platform,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Pressable,
} from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { useLocalSearchParams, router } from 'expo-router';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useSafeBack } from '@/hooks/useSafeBack';
import { customFeedsService, type CustomFeedDetail } from '@/services/customFeedsService';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { useAuth, FollowButton } from '@oxyhq/services';
import Feed from '@/components/Feed/Feed';
import { Ionicons } from '@expo/vector-icons';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';

import { formatCompactNumber } from '@/utils/formatNumber';
import StarRating from '@/components/StarRating';
import { show as toast } from '@oxyhq/bloom/toast';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import BottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { FeedSubscribeButton } from '@/components/FeedSubscribeButton';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { PostUser } from '@mention/shared-types';
import { displayNameOrHandle } from '@/utils/displayName';
import { WEB_BASE_URL } from '@/config';
import { logger } from '@/lib/logger';

type FeedTab = 'recent' | 'profiles' | 'topics' | 'reviews';

/** Reviews per page in the reviews tab. */
const REVIEWS_PAGE_SIZE = 20;

/** The owner/member identity the feed routes embed: the canonical Oxy user. */
type FeedProfile = PostUser;

/** `@handle` for a feed's owner/member, or an empty string when it has none. */
function profileHandle(profile: FeedProfile | null | undefined): string {
  if (!profile) return '';
  const handle = getNormalizedUserHandle(profile);
  return handle ? `@${handle}` : '';
}

const TABS_CONFIG = [
  { id: 'recent', labelKey: 'feeds.detail.tabs.recent' },
  { id: 'profiles', labelKey: 'feeds.detail.tabs.profiles' },
  { id: 'topics', labelKey: 'feeds.detail.tabs.topics' },
  { id: 'reviews', labelKey: 'feeds.detail.tabs.reviews' },
];

// Compact header bar matching Bluesky's ProfileFeedHeader
const FeedHeaderBar = React.memo(function FeedHeaderBar({
  feed,
  subscriberCount,
  isSubscribed,
  isSubscribing,
  onToggleSubscribe,
  isPinned,
  onTogglePin,
  onOpenInfo,
}: {
  feed: CustomFeedDetail;
  subscriberCount: number;
  isSubscribed: boolean;
  isSubscribing: boolean;
  onToggleSubscribe: () => void;
  isPinned: boolean;
  onTogglePin: () => void;
  onOpenInfo: () => void;
}) {
  const theme = useTheme();
  const safeBack = useSafeBack();
  const creatorHandle = profileHandle(feed.owner);

  return (
    <View
      className="flex-row items-center px-2 bg-background"
      style={[headerStyles.bar, { borderBottomColor: theme.colors.border }]}
    >
      <IconButton variant="icon" onPress={safeBack}>
        <BackArrowIcon size={20} className="text-foreground" />
      </IconButton>

      <Pressable
        className="flex-1 flex-row items-center gap-2.5 py-1 px-1"
        onPress={onOpenInfo}
        accessibilityRole="button"
        accessibilityLabel="Open feed info"
      >
        {({ pressed }) => (
          <>
            <View style={[headerStyles.pressHighlight, pressed && { opacity: 1 }]} className="bg-secondary" />
            <Avatar source={feed.coverImage} size={36} variant={MEDIA_VARIANT_AVATAR} />
            <View className="flex-1">
              <Text className="text-[15px] font-bold leading-snug text-foreground" numberOfLines={2}>
                {feed.title}
              </Text>
              <View className="flex-row items-center" style={{ gap: 6 }}>
                {creatorHandle ? (
                  <Text className="text-sm leading-snug text-muted-foreground shrink" numberOfLines={1}>
                    {creatorHandle}
                  </Text>
                ) : null}
                <View className="flex-row items-center" style={{ gap: 2 }}>
                  <Ionicons name="people-outline" size={12} color={theme.colors.textSecondary} />
                  <Text className="text-sm leading-snug text-muted-foreground" numberOfLines={1}>
                    {formatCompactNumber(subscriberCount)}
                  </Text>
                </View>
              </View>
            </View>
            <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} />
          </>
        )}
      </Pressable>

      {/* Subscribing to a feed IS liking it: one `FeedLike` row, the same
          subscription the marketplace and the saved-feeds list read. */}
      <FeedSubscribeButton
        isSubscribed={isSubscribed}
        isSubscribing={isSubscribing}
        onPress={onToggleSubscribe}
      />

      <IconButton variant="icon" onPress={onTogglePin}>
        <Ionicons
          name={isPinned ? 'pin' : 'pin-outline'}
          size={22}
          color={isPinned ? theme.colors.primary : theme.colors.text}
        />
      </IconButton>
    </View>
  );
});

// Feed info bottom sheet content matching Bluesky's DialogInner
const FeedInfoContent = React.memo(function FeedInfoContent({
  feed,
  subscriberCount,
  isSubscribed,
  isSubscribing,
  isPinned,
  isOwner,
  onToggleSubscribe,
  onTogglePin,
  onEdit,
  onShare,
  onClose,
}: {
  feed: CustomFeedDetail;
  subscriberCount: number;
  isSubscribed: boolean;
  isSubscribing: boolean;
  isPinned: boolean;
  isOwner: boolean;
  onToggleSubscribe: () => void;
  onTogglePin: () => void;
  onEdit: () => void;
  onShare: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const creatorHandle = profileHandle(feed.owner);

  return (
    <View className="gap-4 px-5 pb-8 pt-2">
      {/* Avatar + title + share */}
      <View className="flex-row items-center gap-3.5">
        <Avatar source={feed.coverImage} size={48} variant={MEDIA_VARIANT_AVATAR} />
        <View className="flex-1 gap-0.5">
          <Text className="text-2xl font-bold leading-tight text-foreground" numberOfLines={2}>
            {feed.title}
          </Text>
          {creatorHandle ? (
            <TouchableOpacity
              onPress={() => {
                onClose();
                router.push(`/${creatorHandle}`);
              }}
              activeOpacity={0.7}
            >
              <Text className="text-sm leading-relaxed text-muted-foreground">
                By{' '}
                <Text className="underline text-muted-foreground">{creatorHandle}</Text>
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <IconButton variant="icon" onPress={onShare}>
          <Ionicons name="share-outline" size={22} color={theme.colors.text} />
        </IconButton>
      </View>

      {/* Description */}
      {feed.description ? (
        <Text className="text-base leading-relaxed text-foreground">
          {feed.description}
        </Text>
      ) : null}

      {/* Subscriber tally — the same `FeedLike` records the subscribe pill writes. */}
      {subscriberCount > 0 ? (
        <Text className="text-sm text-muted-foreground">
          {t('feeds.subscriberCount', { count: subscriberCount })}
        </Text>
      ) : null}

      {/* Action buttons */}
      <View className="flex-row gap-2.5 pt-1">
        <TouchableOpacity
          className="flex-1 h-10 rounded-lg flex-row items-center justify-center gap-1.5"
          style={{ backgroundColor: theme.colors.backgroundSecondary || theme.colors.border + '40' }}
          onPress={onToggleSubscribe}
          disabled={isSubscribing}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ selected: isSubscribed, busy: isSubscribing }}
        >
          {isSubscribing ? (
            <SpinnerIcon size={16} className="text-foreground" />
          ) : (
            <>
              <Ionicons
                name={isSubscribed ? 'checkmark' : 'add'}
                size={18}
                color={isSubscribed ? theme.colors.primary : theme.colors.text}
              />
              <Text className="text-[15px] font-medium text-foreground">
                {isSubscribed ? t('feeds.subscribed') : t('feeds.subscribe')}
              </Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          className="flex-1 h-10 rounded-lg flex-row items-center justify-center gap-1.5"
          style={{ backgroundColor: isPinned ? theme.colors.primary : (theme.colors.backgroundSecondary || theme.colors.border + '40') }}
          onPress={onTogglePin}
          activeOpacity={0.7}
        >
          <Ionicons
            name={isPinned ? 'pin' : 'pin-outline'}
            size={18}
            color={isPinned ? '#fff' : theme.colors.text}
          />
          <Text
            className="text-[15px] font-medium"
            style={{ color: isPinned ? '#fff' : theme.colors.text }}
          >
            {isPinned ? 'Unpin feed' : 'Pin feed'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Owner-only edit */}
      {isOwner ? (
        <TouchableOpacity
          className="h-10 rounded-lg flex-row items-center justify-center gap-1.5"
          style={{ backgroundColor: theme.colors.backgroundSecondary || theme.colors.border + '40' }}
          onPress={() => {
            onClose();
            onEdit();
          }}
          activeOpacity={0.7}
        >
          <Ionicons name="create-outline" size={18} color={theme.colors.text} />
          <Text className="text-[15px] font-medium text-foreground">Edit feed</Text>
        </TouchableOpacity>
      ) : null}

      {/* Divider + report */}
      <View style={[infoStyles.divider, { backgroundColor: theme.colors.border }]} />
      <View className="flex-row items-center justify-between">
        <Text className="text-sm italic text-muted-foreground">
          Something wrong? Let us know.
        </Text>
        <TouchableOpacity
          className="px-3 h-8 rounded-lg items-center justify-center"
          style={{ backgroundColor: theme.colors.backgroundSecondary || theme.colors.border + '40' }}
          activeOpacity={0.7}
          onPress={() => {
            toast('Report submitted', { type: 'info' });
            onClose();
          }}
        >
          <Text className="text-sm font-medium text-foreground">Report feed</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

// Profiles tab
const ProfilesTab = React.memo(function ProfilesTab({ members }: { members: FeedProfile[] }) {
  const theme = useTheme();

  if (members.length === 0) {
    return (
      <View className="p-10 items-center justify-center gap-3">
        <Ionicons name="people-outline" size={40} color={theme.colors.textSecondary} />
        <Text className="text-base font-medium text-muted-foreground">No profiles yet</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.profilesList}>
      {members.map((member) => {
        // Oxy owns identity: the display name lives at `name.displayName` and
        // falls back to the handle. An unresolved member has no handle at all
        // (the ghost-handle rule), so it gets no profile link.
        const handle = profileHandle(member);
        const name = displayNameOrHandle(member.name?.displayName, handle);

        return (
          <TouchableOpacity
            key={member.id}
            className="flex-row items-center gap-3 py-3"
            onPress={() => {
              if (handle) router.push(`/${handle}`);
            }}
            disabled={!handle}
            activeOpacity={0.7}
          >
            <Avatar source={member.avatar ?? undefined} size={44} variant={MEDIA_VARIANT_AVATAR} />
            <View className="flex-1 gap-0.5">
              <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
                {name}
              </Text>
              {handle ? (
                <Text className="text-sm text-muted-foreground" numberOfLines={1}>
                  {handle}
                </Text>
              ) : null}
            </View>
            <FollowButton userId={member.id} />
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
});

// Topics tab
const TopicsTab = React.memo(function TopicsTab({ keywords }: { keywords: string[] }) {
  const theme = useTheme();

  if (keywords.length === 0) {
    return (
      <View className="p-10 items-center justify-center gap-3">
        <Ionicons name="pricetag-outline" size={40} color={theme.colors.textSecondary} />
        <Text className="text-base font-medium text-muted-foreground">No topics yet</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.topicsList}>
      {keywords.map((keyword) => (
        <View key={keyword} style={[styles.topicRow, { borderBottomColor: theme.colors.border }]}>
          <View className="w-10 h-10 rounded-full items-center justify-center bg-secondary">
            <Ionicons name="pricetag" size={18} color={theme.colors.textSecondary} />
          </View>
          <Text className="text-base font-medium text-foreground">{keyword}</Text>
        </View>
      ))}
    </ScrollView>
  );
});

// Write-review modal
const WriteReviewModal = React.memo(function WriteReviewModal({
  visible,
  onClose,
  onSubmit,
  submitting,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (rating: number, text: string) => void;
  submitting: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');

  const handleSubmit = useCallback(() => {
    if (rating === 0) return;
    onSubmit(rating, text);
  }, [rating, text, onSubmit]);

  const handleClose = useCallback(() => {
    setRating(0);
    setText('');
    onClose();
  }, [onClose]);

  const canSubmit = rating > 0 && !submitting;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        className="flex-1 justify-end"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={reviewStyles.modalBackdrop}
          activeOpacity={1}
          onPress={handleClose}
        />
        <View style={reviewStyles.modalSheet} className="bg-card">
          <View className="w-9 h-1 rounded-sm self-center mb-1 bg-border" />
          <Text className="text-lg font-bold text-center text-foreground">Write a Review</Text>

          <View className="items-center py-1">
            <StarRating
              rating={rating}
              size={32}
              interactive
              onRate={setRating}
              color={theme.colors.primary}
            />
          </View>

          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('feeds.detail.reviewPlaceholder')}
            placeholderTextColor={theme.colors.textSecondary}
            style={reviewStyles.modalTextInput}
            className="text-foreground border border-border bg-secondary"
            multiline
            maxLength={500}
            textAlignVertical="top"
          />

          <View className="flex-row gap-2.5">
            <TouchableOpacity
              className="flex-1 h-11 rounded-xl border border-border items-center justify-center"
              onPress={handleClose}
              activeOpacity={0.7}
            >
              <Text className="text-[15px] font-semibold text-foreground">Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                reviewStyles.modalSubmitBtn,
                { backgroundColor: canSubmit ? theme.colors.primary : theme.colors.border },
              ]}
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.7}
            >
              {submitting ? (
                <SpinnerIcon size={16} className="text-primary-foreground" />
              ) : (
                <Text className="text-[15px] font-bold text-white">Submit</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
});

// Reviews tab
const ReviewsTab = React.memo(function ReviewsTab({ feedId }: { feedId: string }) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [modalVisible, setModalVisible] = useState(false);

  const reviewsQueryKey = useMemo(() => ['customFeedReviews', feedId] as const, [feedId]);

  const reviewsQuery = useInfiniteQuery({
    queryKey: reviewsQueryKey,
    queryFn: ({ pageParam }) =>
      customFeedsService.getReviews(feedId, { page: pageParam, limit: REVIEWS_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
  });

  const reviews = useMemo(
    () => reviewsQuery.data?.pages.flatMap((page) => page.reviews) ?? [],
    [reviewsQuery.data],
  );

  const submitReview = useMutation({
    mutationFn: (input: { rating: number; reviewText: string }) =>
      customFeedsService.submitReview(feedId, {
        rating: input.rating,
        reviewText: input.reviewText.trim() || undefined,
      }),
    onSuccess: () => {
      setModalVisible(false);
      toast('Review submitted', { type: 'success' });
      void queryClient.invalidateQueries({ queryKey: reviewsQueryKey });
    },
    onError: (error) => {
      logger.warn('Failed to submit feed review', { error, feedId });
      toast('Failed to submit review', { type: 'error' });
    },
  });

  const { mutate: mutateReview, isPending: isSubmitting } = submitReview;
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = reviewsQuery;

  const handleSubmitReview = useCallback(
    (rating: number, reviewText: string) => {
      mutateReview({ rating, reviewText });
    },
    [mutateReview],
  );

  const handleLoadMore = useCallback(() => {
    if (isFetchingNextPage || !hasNextPage) return;
    void fetchNextPage();
  }, [isFetchingNextPage, hasNextPage, fetchNextPage]);

  if (reviewsQuery.isPending) {
    return (
      <View className="p-10 items-center justify-center gap-3">
        <SpinnerIcon size={28} className="text-primary" />
      </View>
    );
  }

  return (
    <View className="p-4 gap-1">
      <TouchableOpacity
        className="flex-row items-center justify-center gap-2 py-3 rounded-xl border border-border mb-2"
        onPress={() => setModalVisible(true)}
        activeOpacity={0.7}
      >
        <Ionicons name="create-outline" size={18} color={theme.colors.text} />
        <Text className="text-[15px] font-semibold text-foreground">Write a Review</Text>
      </TouchableOpacity>

      {reviews.length === 0 ? (
        <View className="p-10 items-center justify-center gap-3">
          <Ionicons name="star-outline" size={40} color={theme.colors.textSecondary} />
          <Text className="text-base font-medium text-muted-foreground">No reviews yet</Text>
          <Text className="text-sm text-center text-muted-foreground">
            Be the first to leave a review
          </Text>
        </View>
      ) : (
        reviews.map((review) => {
          const reviewId = review.id || String(review._id);
          // Oxy owns identity: the reviewer's name is `name.displayName`, and an
          // unresolved reviewer degrades to their handle before "Anonymous".
          const reviewerHandle = profileHandle(review.reviewer);
          const reviewerName = displayNameOrHandle(
            review.reviewer?.name?.displayName,
            reviewerHandle || 'Anonymous',
          );
          const date = review.createdAt
            ? new Date(review.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '';

          return (
            <View
              key={reviewId}
              style={[reviewStyles.reviewCard, { borderBottomColor: theme.colors.border }]}
            >
              <View className="flex-row items-start gap-2.5">
                <Avatar source={review.reviewer?.avatar ?? undefined} size={36} variant={MEDIA_VARIANT_AVATAR} />
                <View className="flex-1 gap-[3px]">
                  <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
                    {reviewerName}
                  </Text>
                  <View className="flex-row items-center gap-2">
                    <StarRating rating={review.rating || 0} size={13} color={theme.colors.primary} />
                    {date ? (
                      <Text className="text-xs text-muted-foreground">
                        {date}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
              {review.reviewText ? (
                <Text className="text-sm leading-5 text-foreground">
                  {review.reviewText}
                </Text>
              ) : null}
            </View>
          );
        })
      )}

      {hasNextPage && (
        <TouchableOpacity
          className="py-5 items-center justify-center"
          onPress={handleLoadMore}
          disabled={isFetchingNextPage}
          activeOpacity={0.7}
        >
          {isFetchingNextPage ? (
            <SpinnerIcon size={20} className="text-primary" />
          ) : (
            <Text className="text-sm font-semibold text-primary">
              Load more reviews
            </Text>
          )}
        </TouchableOpacity>
      )}

      <WriteReviewModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onSubmit={handleSubmitReview}
        submitting={isSubmitting}
      />
    </View>
  );
});

export default function CustomFeedTimelineScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { id } = useLocalSearchParams<{ id: string }>();
  const feedId = typeof id === 'string' ? id : '';
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { isPinned: isFeedPinned, pin, unpin } = useFeedPreferences();
  const [activeTab, setActiveTab] = useState<FeedTab>('recent');

  // The viewer identity is part of the key: `isLiked` is per-viewer, so a feed
  // fetched while a cold-boot SSO restore is still in flight must not keep
  // showing its anonymous "not subscribed" snapshot once the session lands.
  const authKey = isAuthenticated && user?.id ? user.id : 'anon';
  const feedQueryKey = useMemo(() => ['customFeed', feedId, authKey] as const, [feedId, authKey]);

  const feedQuery = useQuery({
    queryKey: feedQueryKey,
    queryFn: () => customFeedsService.get(feedId),
    enabled: feedId.length > 0,
  });

  const feed = feedQuery.data ?? null;

  // The subscription state the WHOLE app reads: a `FeedLike` row (`isLiked`) and
  // the feed's subscriber tally (`likeCount`). Derived from the query cache, so
  // the header pill and the info sheet can never disagree.
  const isSubscribed = feed?.isLiked ?? false;
  const subscriberCount = feed?.likeCount ?? 0;

  const pinKey = `custom:${feedId}`;
  const isPinned = isFeedPinned(pinKey);
  const isOwner = Boolean(feed?.ownerOxyUserId && user?.id && feed.ownerOxyUserId === user.id);

  const TABS = useMemo(() => TABS_CONFIG.map((tab) => ({ id: tab.id, label: t(tab.labelKey) })), [t]);

  const infoSheetRef = useRef<BottomSheetRef>(null);

  const openInfoSheet = useCallback(() => {
    infoSheetRef.current?.present();
  }, []);

  const closeInfoSheet = useCallback(() => {
    infoSheetRef.current?.dismiss();
  }, []);

  const onTogglePin = useCallback(() => {
    if (isFeedPinned(pinKey)) unpin(pinKey);
    else pin({ key: pinKey, descriptor: `custom|${feedId}` });
  }, [feedId, pinKey, isFeedPinned, pin, unpin]);

  const onEdit = useCallback(() => {
    router.push(`/feeds/${feedId}/edit`);
  }, [feedId]);

  /**
   * Subscribe / unsubscribe. `POST|DELETE /feeds/:id/like` is the ONE
   * custom-feed subscription endpoint — it writes the `FeedLike` row and moves
   * `CustomFeed.subscriberCount`, which is what the marketplace, the saved-feeds
   * list and this screen all read back.
   */
  const subscription = useMutation({
    mutationFn: (nextSubscribed: boolean) =>
      nextSubscribed ? customFeedsService.likeFeed(feedId) : customFeedsService.unlikeFeed(feedId),
    onMutate: async (nextSubscribed) => {
      await queryClient.cancelQueries({ queryKey: feedQueryKey });
      const previous = queryClient.getQueryData<CustomFeedDetail>(feedQueryKey);
      queryClient.setQueryData<CustomFeedDetail>(feedQueryKey, (current) =>
        current
          ? {
              ...current,
              isLiked: nextSubscribed,
              likeCount: Math.max(0, (current.likeCount ?? 0) + (nextSubscribed ? 1 : -1)),
            }
          : current,
      );
      return { previous };
    },
    onSuccess: (result) => {
      // The server is authoritative — it also settles the idempotent cases
      // (subscribing to a feed the viewer already subscribed to).
      queryClient.setQueryData<CustomFeedDetail>(feedQueryKey, (current) =>
        current ? { ...current, isLiked: result.liked, likeCount: result.likeCount } : current,
      );
    },
    onError: (error, _nextSubscribed, context) => {
      if (context?.previous) {
        queryClient.setQueryData(feedQueryKey, context.previous);
      }
      logger.warn('Failed to update feed subscription', { error, feedId });
      toast(t('feeds.subscribeError'), { type: 'error' });
    },
  });

  const { mutate: mutateSubscription, isPending: isSubscribing } = subscription;

  const onToggleSubscribe = useCallback(() => {
    if (isSubscribing) return;
    mutateSubscription(!isSubscribed);
  }, [isSubscribing, isSubscribed, mutateSubscription]);

  const onShare = useCallback(async () => {
    if (!feed) return;
    const url = `${WEB_BASE_URL}/feeds/${feedId}`;
    try {
      await Share.share({
        message: `Check out "${feed.title}" on Mention!\n\n${url}`,
        url,
        title: `${feed.title} on Mention`,
      });
    } catch (error) {
      logger.warn('Failed to share feed', { error, feedId });
    }
  }, [feed, feedId]);

  const handleTabPress = useCallback((tabId: string) => {
    setActiveTab(tabId as FeedTab);
  }, []);

  const members: FeedProfile[] = feed?.members ?? [];
  const keywords: string[] = feed?.keywords ?? [];

  const tabBar = useMemo(() => (
    <AnimatedTabBar
      tabs={TABS}
      activeTabId={activeTab}
      onTabPress={handleTabPress}
      instanceId={`feed-detail-${feedId}`}
    />
  ), [TABS, activeTab, handleTabPress, feedId]);

  const listHeader = useMemo(() => {
    if (!feed) return null;
    return <View>{tabBar}</View>;
  }, [feed, tabBar]);

  // A missing route param can never resolve to a feed — surface it as the same
  // failure the user would get from a dead feed id rather than spinning forever.
  const hasError = feedQuery.isError || feedId.length === 0;
  const isLoading = feedQuery.isPending && !hasError;

  return (
    <ThemedView className="flex-1 relative flex-col">
      {/* Compact Bluesky-style header */}
      {feed ? (
        <FeedHeaderBar
          feed={feed}
          subscriberCount={subscriberCount}
          isSubscribed={isSubscribed}
          isSubscribing={isSubscribing}
          onToggleSubscribe={onToggleSubscribe}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          onOpenInfo={openInfoSheet}
        />
      ) : (
        <View
          className="flex-row items-center px-2 bg-background"
          style={[headerStyles.bar, { borderBottomColor: theme.colors.border }]}
        >
          <IconButton variant="icon" onPress={safeBack}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>
          <View className="flex-1 py-3 px-2">
            <Text className="text-[15px] font-bold text-foreground">Feed</Text>
          </View>
        </View>
      )}

      {hasError ? (
        <View className="flex-1 items-center justify-center">
          <Text style={{ color: theme.colors.error || theme.colors.textSecondary }}>
            {t('feeds.loadError')}
          </Text>
        </View>
      ) : isLoading ? (
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={24} className="text-primary" />
        </View>
      ) : activeTab === 'recent' ? (
        // `recent` is the ONLY feed tab and it is the virtualized, scroll-owning
        // Feed (NOT scrollEnabled={false}) — it owns the document scroll on web
        // (window virtualizer) with the tab bar passed as its listHeaderComponent.
        // It renders the stored definition through the engine timeline (the same
        // `/feeds/:id/timeline` the home custom tabs use), so definition-based
        // feeds render here too. The other tabs (profiles/topics/reviews) render
        // NON-feed content inside their own <ScrollView>.
        <Feed type="custom" filters={{ customFeedId: feedId }} listHeaderComponent={listHeader} />
      ) : (
        <ScrollView stickyHeaderIndices={[0]}>
          {tabBar}
          {activeTab === 'profiles' && <ProfilesTab members={members} />}
          {activeTab === 'topics' && <TopicsTab keywords={keywords} />}
          {activeTab === 'reviews' && <ReviewsTab feedId={feedId} />}
        </ScrollView>
      )}

      {/* FAB that rides the BottomBar's show/hide (web mobile). */}
      {!isLoading && !hasError && (
        <BottomBarAwareFab
          onPress={() => router.push('/compose')}
          icon={<ComposeIcon size={22} className="text-primary-foreground" />}
          accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
        />
      )}

      {/* Feed info bottom sheet */}
      {feed && (
        <BottomSheet
          ref={infoSheetRef}
          enablePanDownToClose
        >
          <FeedInfoContent
            feed={feed}
            subscriberCount={subscriberCount}
            isSubscribed={isSubscribed}
            isSubscribing={isSubscribing}
            isPinned={isPinned}
            isOwner={isOwner}
            onToggleSubscribe={onToggleSubscribe}
            onTogglePin={onTogglePin}
            onEdit={onEdit}
            onShare={onShare}
            onClose={closeInfoSheet}
          />
        </BottomSheet>
      )}
    </ThemedView>
  );
}

const headerStyles = StyleSheet.create({
  bar: {
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressHighlight: {
    ...StyleSheet.absoluteFill,
    borderRadius: 8,
    opacity: 0,
  },
});

const infoStyles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
});

const styles = StyleSheet.create({
  profilesList: {
    padding: 16,
    gap: 4,
  },
  topicsList: {
    padding: 16,
  },
  topicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

const reviewStyles = StyleSheet.create({
  reviewCard: {
    paddingVertical: 16,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 16,
    ...Platform.select({
      ios: { paddingBottom: 36 },
      default: { paddingBottom: 24 },
    }),
  },
  modalTextInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    minHeight: 100,
    fontSize: 15,
    ...Platform.select({
      web: { outlineWidth: 0 },
    }),
  },
  modalSubmitBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
