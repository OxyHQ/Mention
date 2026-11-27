import { DetailSkeleton, ListSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import React, { useState, useCallback, useMemo } from 'react';
import { StyleSheet, Pressable, type ViewStyle } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RiEditBoxLine } from '@oxy.so/bloom/icons/RiEditBoxLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHashtag } from '@oxy.so/bloom/icons/RiHashtag';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { RiPushpinFill } from '@oxy.so/bloom/icons/RiPushpinFill';
import { RiPushpinLine } from '@oxy.so/bloom/icons/RiPushpinLine';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useTheme } from '@oxy.so/bloom/theme';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { customFeedsService, type CustomFeedDetail } from '@/services/customFeedsService';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { useAuth } from '@oxy.so/services/ui/client';
import { ProfileCard } from '@/components/ProfileCard';
import Feed from '@/components/Feed/Feed';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { formatCompactNumber } from '@/utils/formatNumber';

import { shareLink } from '@/utils/shareLink';
import { Rating, RatingInput } from '@oxy.so/bloom/rating';
import { EmptyState } from '@/components/common/EmptyState';
import { toast } from '@oxy.so/bloom/toast';
import type { DialogAction } from '@oxy.so/bloom/dialog';
import { useTranslation } from 'react-i18next';
import {
  Avatar as LAvatar,
  Button as LButton,
  Dialog,
  Divider as LDivider,
  Embed,
  HStack,
  Icon,
  RawText,
  TextEditor,
  VStack,
  defineTokens,
  toElement,
  view,
  Embed as LEmbed,
  Header,
  Icon as LIcon,
  TabItem,
  Tabs as LTabs,
  VStack as LVStack,
  toElement as LtoElement,
  Header as LHeader,
  Group,
  ScrollView,
} from '@oxy.so/bloom-language';
import { FeedSubscribeButton } from '@/components/FeedSubscribeButton';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import type { PostUser } from '@mention/shared-types';
import { displayNameOrHandle } from '@/utils/displayName';
import { WEB_BASE_URL } from '@/config';
import { logger } from '@oxy.so/core/logger';
import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';

import { screen } from '@oxy.so/bloom-language/router';
import { accountCacheWriter } from '@/lib/queryClient';

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

const feedTokens = defineTokens({ avatarSize: { info: 48 } });

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
  const { t } = useTranslation();
  const back = useScreenBack();
  const creatorHandle = profileHandle(feed.owner);
  // The bare handle (no `@`) the hover preview resolves; `creatorHandle` is the
  // display form.
  const ownerHandle = getNormalizedUserHandle(feed.owner) ?? undefined;

  return LtoElement(
    LHeader(
      LEmbed(
        <Pressable
          style={headerTitleStyle}
          onPress={onOpenInfo}
          accessibilityRole="button"
          accessibilityLabel="Open feed info"
        >
          {({ pressed }) => (
            <>
              {toElement(
                VStack()
                  .position({ top: 'none', bottom: 'none', left: 'none', right: 'none' })
                  .background('mutedFill')
                  .corner('sm')
                  .opacity(pressed ? 'opaque' : 'transparent'),
              )}
              {LtoElement(LAvatar(feed.coverImage, { variant: MEDIA_VARIANT_AVATAR }).size('lg'))}
              {toElement(
                VStack(
                  RawText(feed.title)
                    .font('md')
                    .weight('bold')
                    .leading('easy')
                    .foreground('foreground')
                    .lines(2),
                  HStack(
                    creatorHandle
                      ? Embed(
                          <ProfileHoverCard username={ownerHandle}>
                            {toElement(
                              RawText(creatorHandle)
                                .font('14')
                                .leading('easy')
                                .foreground('muted')
                                .shrink('normal')
                                .lines(1),
                            )}
                          </ProfileHoverCard>,
                        )
                      : null,
                    HStack(
                      Icon(RiGroupLine).size('xs').foreground('muted'),
                      RawText(formatCompactNumber(subscriberCount))
                        .font('14')
                        .leading('easy')
                        .foreground('muted')
                        .lines(1),
                    )
                      .align('center')
                      .spacing('2xs'),
                  )
                    .align('center')
                    .spacing('6'),
                ).flex('1'),
              )}
              {toElement(Icon(RiMoreFill).size('18').foreground('muted'))}
            </>
          )}
        </Pressable>,
      ),
    )
      .onBack(back)
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .toolbar(
        LEmbed(
          <>
            {/* Subscribing to a feed IS liking it: one `FeedLike` row, the same
    subscription the marketplace and the saved-feeds list read. */}
            <FeedSubscribeButton
              isSubscribed={isSubscribed}
              isSubscribing={isSubscribing}
              onPress={onToggleSubscribe}
            />

            {LtoElement(
              LButton(
                LIcon(isPinned ? RiPushpinFill : RiPushpinLine)
                  .size('md')
                  .foreground(isPinned ? 'primary' : 'foreground'),
              )
                .style('subtle')
                .tint('neutral')
                .shape('circle')
                .onPress(onTogglePin)
                .label(isPinned ? 'Unpin feed' : 'Pin feed'),
            )}
          </>,
        ),
      )
      .inPage(),
  );
});

// Feed info dialog content matching Bluesky's DialogInner
const FeedInfoContent = view(function FeedInfoContent({
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
  const router = useRouter();
  const { t } = useTranslation();
  const creatorHandle = profileHandle(feed.owner);

  return VStack(
    /* Avatar + title + share */ HStack(
      LAvatar(feed.coverImage, { variant: MEDIA_VARIANT_AVATAR }).size(feedTokens.avatarSize.info),
      VStack(
        RawText(feed.title)
          .font('24')
          .weight('bold')
          .leading('close')
          .foreground('foreground')
          .lines(2),
        creatorHandle
          ? RawText(
              'By',
              ' ',
              RawText(creatorHandle)
                .underline()
                .foreground('muted')
                .role('link')
                .onPress(() => {
                  onClose();
                  router.push(`/${creatorHandle}`);
                }),
            )
              .font('14')
              .leading('relaxed')
              .foreground('muted')
          : null,
      )
        .flex('1')
        .spacing('2xs'),
      LButton(Icon(RiShare2Line))
        .style('subtle')
        .tint('neutral')
        .shape('circle')
        .onPress(onShare)
        .label(t('videos.share', { defaultValue: 'Share' })),
    )
      .align('center')
      .spacing('14'),
    /* Description */ feed.description
      ? RawText(feed.description).font('16').leading('relaxed').foreground('foreground')
      : null,
    /* Subscriber tally — the same `FeedLike` records the subscribe pill writes. */ subscriberCount >
      0
      ? RawText(t('feeds.subscriberCount', { count: subscriberCount }))
          .font('14')
          .leading('20px')
          .foreground('muted')
      : null,
    /* Action buttons */ HStack(
      Embed(
        <FeedSubscribeButton
          isSubscribed={isSubscribed}
          isSubscribing={isSubscribing}
          onPress={onToggleSubscribe}
        />,
      ),
      LButton(
        Icon(isPinned ? RiPushpinFill : RiPushpinLine),
        RawText(isPinned ? 'Unpin feed' : 'Pin feed'),
      )
        .style(isPinned ? 'solid' : 'subtle')
        .tint(isPinned ? 'accent' : 'neutral')
        .flex('1')
        .onPress(onTogglePin),
    )
      .padding('top', 'xs')
      .spacing('10'),
    /* Owner-only edit */ isOwner
      ? LButton(Icon(RiEditBoxLine), RawText('Edit feed'))
          .style('subtle')
          .tint('neutral')
          .onPress(() => {
            onClose();
            onEdit();
          })
      : null,
    /* Divider + report */ LDivider(),
    HStack(
      RawText('Something wrong? Let us know.')
        .font('14')
        .leading('20px')
        .italic()
        .foreground('muted'),
      LButton(RawText('Report feed'))
        .style('subtle')
        .tint('neutral')
        .size('sm')
        .onPress(() => {
          toast('Report submitted', { type: 'info' });
          onClose();
        }),
    )
      .align('center')
      .justify('between'),
  )
    .padding('horizontal', 'xl')
    .padding('bottom', '3xl')
    .padding('top', 'sm')
    .spacing('lg');
});

// Profiles tab
const ProfilesTab = React.memo(function ProfilesTab({ members }: { members: FeedProfile[] }) {
  if (members.length === 0) {
    return <EmptyState title="No profiles yet" sticker="feedPageEmpty" />;
  }

  return LtoElement(
    LVStack(
      LEmbed(
        members.map((member) => <ProfileCard key={member.id} profile={member} showFollowButton />),
      ),
    )
      .padding('all', 'lg')
      .spacing('xs'),
  );
});

// Topics tab
const TopicsTab = React.memo(function TopicsTab({ keywords }: { keywords: string[] }) {
  if (keywords.length === 0) {
    return <EmptyState title="No topics yet" sticker="feedPageEmpty" />;
  }

  return toElement(
    VStack(
      keywords.map((keyword) =>
        HStack(
          VStack(Icon(RiHashtag).size('18').foreground('muted'))
            .frame({ width: '4xl', height: '4xl' })
            .background('mutedFill')
            .corner('infinite')
            .align('center')
            .justify('center'),
          RawText(keyword).font('16').leading('normal').weight('medium').foreground('foreground'),
        )
          .align('center')
          .spacing('14')
          .padding('vertical', '14')
          .border('border', 'hairline', 'bottom')
          .id(keyword),
      ),
    ).padding('lg'),
  );
});

// Write-review dialog, shown while `open` holds; dismissing it (cancel, a drag
// down) calls `onOpenChange(false)`.
const WriteReviewDialog = React.memo(function WriteReviewDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (rating: number, text: string) => void;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  const [rating, setRating] = useState<number | null>(null);
  const [text, setText] = useState('');

  // Each opening starts a fresh draft. It is cleared as the dialog opens, not as
  // it closes: a close (`onOpenChange(false)`, or the submit closing it) starts
  // the exit, and the closing dialog keeps showing its draft until it is gone.
  const [draftFor, setDraftFor] = useState(open);
  if (draftFor !== open) {
    setDraftFor(open);
    if (open) {
      setRating(null);
      setText('');
    }
  }

  const actions = useMemo<DialogAction[]>(
    () => [
      { label: 'Cancel', color: 'cancel' },
      {
        label: 'Submit',
        disabled: rating === null,
        loading: submitting,
        shouldCloseOnPress: false,
        onPress: () => {
          if (rating !== null) onSubmit(rating, text);
        },
      },
    ],
    [rating, text, submitting, onSubmit],
  );

  return toElement(
    Dialog(
      VStack(
        VStack(
          Embed(<RatingInput value={rating} onChange={setRating} accessibilityLabel="Rating" />),
        )
          .padding('vertical', 'xs')
          .align('center'),
        TextEditor([text, setText])
          .placeholder(t('feeds.detail.reviewPlaceholder'))
          .maxLength(500)
          .rows(4),
      ).spacing('lg'),
    )
      .label('Write a Review')
      .title('Write a Review')
      .presentAt('bottom', { md: 'center' })
      .buttons(actions)
      .presented([open, onOpenChange]),
  );
});

// Reviews tab
const ReviewsTab = React.memo(function ReviewsTab({ feedId }: { feedId: string }) {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [reviewOpen, setReviewOpen] = useState(false);

  const reviewsQueryKey = useMemo(() => publicQueryKeys.customFeedReviews(feedId), [feedId]);

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
      setReviewOpen(false);
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
    return <ListSkeleton />;
  }

  return toElement(
    VStack(
      LButton(Icon(RiEditBoxLine), RawText('Write a Review'))
        .style('outline')
        .tint('neutral')
        // Its class's margin reached the outline button on native only: on the web
        // the outline button's own margin won over the class.
        .when('native', (v) => v.margin('bottom', 'sm'))
        .onPress(() => setReviewOpen(true)),
      reviews.length === 0
        ? Embed(
            <EmptyState
              title="No reviews yet"
              subtitle="Be the first to leave a review"
              sticker="feedPageEmpty"
            />,
          )
        : reviews.map((review) => {
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

            return VStack(
              HStack(
                LAvatar(review.reviewer?.avatar ?? undefined, {
                  variant: MEDIA_VARIANT_AVATAR,
                }).size('lg'),
                VStack(
                  RawText(reviewerName)
                    .font('md')
                    .weight('semibold')
                    .foreground('foreground')
                    .lines(1),
                  HStack(
                    Embed(
                      <Rating
                        variant="stars"
                        size="sm"
                        value={review.rating || 0}
                        starColor={theme.colors.primary}
                      />,
                    ),
                    date ? RawText(date).font('xs').leading('16px').foreground('muted') : null,
                  )
                    .align('center')
                    .spacing('sm'),
                )
                  .flex('1')
                  .spacing('3'),
              )
                .align('start')
                .spacing('10'),
              review.reviewText
                ? RawText(review.reviewText).font('14').leading('20px').foreground('foreground')
                : null,
            )
              .padding('vertical', 'lg')
              .spacing('sm')
              .border('border', 'hairline', 'bottom')
              .id(reviewId);
          }),
      hasNextPage
        ? LButton(RawText('Load more reviews'))
            .style('plain')
            .tint('accent')
            .loading(isFetchingNextPage)
            .margin('vertical', 'md')
            .onPress(handleLoadMore)
        : null,
      Embed(
        <WriteReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          onSubmit={handleSubmitReview}
          submitting={isSubmitting}
        />,
      ),
    )
      .padding('lg')
      .spacing('xs'),
  );
});

const CustomFeedTimelineScreen = screen(function CustomFeedTimelineScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const back = useScreenBack();
  const { id } = useLocalSearchParams<{ id: string }>();
  const feedId = typeof id === 'string' ? id : '';
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { isPinned: isFeedPinned, pin, unpin } = useFeedPreferences();
  const [activeTab, setActiveTab] = useState<FeedTab>('recent');

  // The viewer identity is part of the key: `isLiked` is per-viewer, so a feed
  // fetched while a cold-boot SSO restore is still in flight must not keep
  // showing its anonymous "not subscribed" snapshot once the session lands.
  const feedQueryKey = useMemo(
    () => viewerQueryKeys.customFeed(user?.id, feedId),
    [feedId, user?.id],
  );

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

  const TABS = useMemo(
    () => TABS_CONFIG.map((tab) => ({ id: tab.id, label: t(tab.labelKey) })),
    [t],
  );

  const [infoOpen, setInfoOpen] = useState(false);
  const openInfoSheet = useCallback(() => setInfoOpen(true), []);
  const closeInfoSheet = useCallback(() => setInfoOpen(false), []);

  const onTogglePin = useCallback(() => {
    if (isFeedPinned(pinKey)) unpin(pinKey);
    else pin({ key: pinKey, descriptor: `custom|${feedId}` });
  }, [feedId, pinKey, isFeedPinned, pin, unpin]);

  const onEdit = useCallback(() => {
    router.push(`/feeds/${feedId}/edit`);
  }, [feedId, router]);

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
      // The account this write is for: after the await it may be gone.
      const write = accountCacheWriter(queryClient);
      await queryClient.cancelQueries({ queryKey: feedQueryKey });
      const previous = queryClient.getQueryData<CustomFeedDetail>(feedQueryKey);
      write.setQueryData<CustomFeedDetail>(feedQueryKey, (current) =>
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
    await shareLink({
      title: `${feed.title} on Mention`,
      message: `Check out "${feed.title}" on Mention!`,
      url,
      copiedToast: t('widgetMenu.linkCopied'),
      errorToast: t('widgetMenu.shareFailed'),
    });
  }, [feed, feedId, t]);

  const handleTabPress = useCallback((tabId: string) => {
    setActiveTab(tabId as FeedTab);
  }, []);

  const members: FeedProfile[] = feed?.members ?? [];
  const keywords: string[] = feed?.keywords ?? [];

  const tabBar = useMemo(
    () =>
      LtoElement(
        LTabs(
          [activeTab, handleTabPress],
          TABS.map((tab: { id: string; label: string; count?: number }) =>
            TabItem(tab.id, tab.label).count(tab.count),
          ),
        ).style('underline'),
      ),
    [TABS, activeTab, handleTabPress, feedId],
  );

  const listHeader = useMemo(() => {
    if (!feed) return null;
    return LtoElement(LVStack(LEmbed(tabBar)));
  }, [feed, tabBar]);

  // A missing route param can never resolve to a feed — surface it as the same
  // failure the user would get from a dead feed id rather than spinning forever.
  const hasError = feedQuery.isError || feedId.length === 0;
  const isLoading = feedQuery.isPending && !hasError;

  return Group(
    LEmbed(
      hasError ? (
        toElement(
          VStack(RawText(t('feeds.loadError')).foreground('error'))
            .flex('1')
            .align('center')
            .justify('center'),
        )
      ) : isLoading ? (
        <DetailSkeleton />
      ) : activeTab === 'recent' ? (
        // `recent` is the ONLY feed tab and it is the virtualized, scroll-owning
        // Feed (NOT scrollEnabled={false}) — it owns the document scroll on web
        // (window virtualizer) with the tab bar passed as its listHeaderComponent.
        // It renders the stored definition through the engine timeline (the same
        // `/feeds/:id/timeline` the home custom tabs use), so definition-based
        // feeds render here too. The other tabs (profiles/topics/reviews) render
        // NON-feed content in the screen's own scroller.
        <Feed type="custom" filters={{ customFeedId: feedId }} listHeaderComponent={listHeader} />
      ) : (
        LtoElement(
          ScrollView(
            LEmbed(tabBar),
            activeTab === 'profiles' ? LEmbed(<ProfilesTab members={members} />) : null,
            activeTab === 'topics' ? LEmbed(<TopicsTab keywords={keywords} />) : null,
            activeTab === 'reviews' ? LEmbed(<ReviewsTab feedId={feedId} />) : null,
          ).stickyIndices([0]),
        )
      ),
    ),
    // Feed info
    LEmbed(
      feed
        ? toElement(
            Dialog(
              FeedInfoContent({
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
                onClose: closeInfoSheet,
              }),
            )
              .label(feed.title)
              .presentAt('bottom', { md: 'center' })
              .padding('none')
              .presented([infoOpen, setInfoOpen]),
          )
        : null,
    ),
  )
    .screenScroll('auto')
    .header(
      // Compact Bluesky-style header
      feed
        ? LEmbed(
            <FeedHeaderBar
              feed={feed}
              subscriberCount={subscriberCount}
              isSubscribed={isSubscribed}
              isSubscribing={isSubscribing}
              onToggleSubscribe={onToggleSubscribe}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              onOpenInfo={openInfoSheet}
            />,
          )
        : Header('Feed')
            .onBack(back)
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .inPage(),
    );
});

// The title stays React Native's Pressable: its pressed highlight is a view of its
// own, drawn from the press state its children render with. This draws its classes:
// `flex-1 flex-row items-center gap-2.5 py-1 px-1`.
const headerTitleStyle: ViewStyle = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: '0%',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  paddingVertical: 4,
  paddingHorizontal: 4,
};

const styles = StyleSheet.create({
  profilesList: {
    padding: 16,
    gap: 4,
  },
});

export default function AvailableCustomFeedTimelineScreen() {
  return (
    <SupervisedFeatureGate>
      <CustomFeedTimelineScreen />
    </SupervisedFeatureGate>
  );
}
