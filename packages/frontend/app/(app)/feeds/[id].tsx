import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
  ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import Feed from '@/components/Feed/Feed';
import { Ionicons } from '@expo/vector-icons';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import Avatar from '@/components/Avatar';
import { getData, storeData } from '@/utils/storage';
import { formatCompactNumber } from '@/utils/formatNumber';
import StarRating from '@/components/StarRating';
import { toast } from '@/lib/sonner';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import * as OxyServicesNS from '@oxyhq/services';

const PINNED_KEY = 'mention.pinnedFeeds';

type FeedTab = 'recent' | 'profiles' | 'topics' | 'reviews';

interface MemberProfile {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
}

const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string }> | undefined;

const TABS = [
  { id: 'recent', label: 'Recent' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'topics', label: 'Topics' },
  { id: 'reviews', label: 'Reviews' },
];

const AVATAR_GRID_SIZE = 38;
const AVATAR_GRID_GAP = 3;

// 2x2 avatar grid matching Threads design
const AvatarGrid = React.memo(function AvatarGrid({ avatars }: { avatars: string[] }) {
  if (!avatars.length) return null;
  const displayed = avatars.slice(0, 4);
  return (
    <View style={styles.avatarGrid}>
      {displayed.map((uri, i) => (
        <View
          key={`${uri}-${i}`}
          style={{
            position: 'absolute',
            top: i < 2 ? 0 : AVATAR_GRID_SIZE + AVATAR_GRID_GAP,
            left: i % 2 === 0 ? 0 : AVATAR_GRID_SIZE + AVATAR_GRID_GAP,
          }}
        >
          <Avatar source={uri} size={AVATAR_GRID_SIZE} />
        </View>
      ))}
    </View>
  );
});

// Hero section
const FeedHero = React.memo(function FeedHero({
  feed,
  memberAvatars,
  memberCount,
  topicCount,
  likeCount,
  isLiked,
  isTogglingLike,
  onShare,
  onToggleLike,
}: {
  feed: any;
  memberAvatars: string[];
  memberCount: number;
  topicCount: number;
  likeCount: number;
  isLiked: boolean;
  isTogglingLike: boolean;
  onShare: () => void;
  onToggleLike: () => void;
}) {
  const theme = useTheme();

  const subtitleParts = useMemo(() => {
    const parts: string[] = [];
    if (topicCount > 0) parts.push(`${topicCount} ${topicCount === 1 ? 'topic' : 'topics'}`);
    if (memberCount > 0) parts.push(`${memberCount} ${memberCount === 1 ? 'profile' : 'profiles'}`);
    return parts.join(' \u00B7 ');
  }, [topicCount, memberCount]);

  const metaLine = useMemo(() => {
    const parts: string[] = [];
    if (feed.owner) parts.push(`Feed by ${feed.owner.displayName || feed.owner.username}`);
    if (likeCount > 0) parts.push(`Pinned by ${formatCompactNumber(likeCount)}`);
    return parts.join(' \u00B7 ');
  }, [feed.owner, likeCount]);

  return (
    <View className="p-5 gap-3">
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1 gap-1">
          <Text className="text-[26px] font-extrabold leading-8 text-foreground">{feed.title}</Text>
          {subtitleParts ? (
            <Text className="text-[15px] leading-5 text-muted-foreground">
              {subtitleParts}
            </Text>
          ) : null}
        </View>
        {memberAvatars.length > 0 && <AvatarGrid avatars={memberAvatars} />}
      </View>

      {feed.description ? (
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          {feed.description}
        </Text>
      ) : null}

      {metaLine ? (
        <Text className="text-sm leading-[18px] text-muted-foreground">{metaLine}</Text>
      ) : null}

      <View className="flex-row gap-2.5 mt-1">
        <TouchableOpacity
          className="flex-1 h-10 rounded-[10px] border border-border items-center justify-center"
          onPress={onShare}
          activeOpacity={0.7}
        >
          <Text className="text-[15px] font-semibold text-foreground">Share feed</Text>
        </TouchableOpacity>
        <TouchableOpacity
          className="flex-1 h-10 rounded-[10px] border border-border items-center justify-center"
          onPress={onToggleLike}
          disabled={isTogglingLike}
          activeOpacity={0.7}
        >
          <Text className="text-[15px] font-semibold text-foreground">
            {isLiked ? 'Pinned' : 'Pin feed'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

// Profiles tab
const ProfilesTab = React.memo(function ProfilesTab({ members }: { members: MemberProfile[] }) {
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
      {members.map((m) => (
        <TouchableOpacity
          key={m.id}
          className="flex-row items-center gap-3 py-3"
          onPress={() => router.push(`/@${m.username}` as any)}
          activeOpacity={0.7}
        >
          <Avatar source={m.avatar} size={44} />
          <View className="flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
              {m.username}
            </Text>
            <Text className="text-sm text-muted-foreground" numberOfLines={1}>
              {m.displayName}
            </Text>
          </View>
          {FollowButton && <FollowButton userId={m.id} />}
        </TouchableOpacity>
      ))}
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
            placeholder="Share your thoughts about this feed... (optional)"
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
                <ActivityIndicator size="small" color="#fff" />
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
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadReviews = useCallback(
    async (pageNum: number, replace: boolean) => {
      if (replace) setLoading(true);
      else setLoadingMore(true);
      try {
        const res = await customFeedsService.getReviews(feedId, { page: pageNum, limit: 20 });
        const items = res.reviews || [];
        setReviews((prev) => (replace ? items : [...prev, ...items]));
        setPage(pageNum);
        setTotalPages(res.totalPages || 1);
      } catch {
        // silently fail — empty state handles it
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [feedId],
  );

  useEffect(() => {
    loadReviews(1, true);
  }, [loadReviews]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || loading || page >= totalPages) return;
    loadReviews(page + 1, false);
  }, [loadingMore, loading, page, totalPages, loadReviews]);

  const handleSubmitReview = useCallback(
    async (rating: number, reviewText: string) => {
      setSubmitting(true);
      try {
        await customFeedsService.submitReview(feedId, { rating, reviewText: reviewText.trim() || undefined });
        setModalVisible(false);
        toast.success('Review submitted');
        loadReviews(1, true);
      } catch {
        toast.error('Failed to submit review');
      } finally {
        setSubmitting(false);
      }
    },
    [feedId, loadReviews],
  );

  if (loading) {
    return (
      <View className="p-10 items-center justify-center gap-3">
        <ActivityIndicator size="large" color={theme.colors.primary} />
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
          const reviewId = String(review._id || review.id);
          const reviewerName =
            review.reviewer?.displayName || review.reviewer?.username || 'Anonymous';
          const reviewerAvatar = review.reviewer?.avatar;
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
                <Avatar source={reviewerAvatar} size={36} label={reviewerName} />
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

      {page < totalPages && (
        <TouchableOpacity
          className="py-5 items-center justify-center"
          onPress={handleLoadMore}
          disabled={loadingMore}
          activeOpacity={0.7}
        >
          {loadingMore ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
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
        submitting={submitting}
      />
    </View>
  );
});

export default function CustomFeedTimelineScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [feed, setFeed] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authorsCsv, setAuthorsCsv] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [isTogglingLike, setIsTogglingLike] = useState(false);
  const [activeTab, setActiveTab] = useState<FeedTab>('recent');

  useEffect(() => {
    (async () => {
      try {
        const stored = (await getData<string[]>(PINNED_KEY)) || [];
        setPinned(stored);
      } catch { }
    })();
  }, []);

  const onTogglePin = useCallback(async () => {
    const feedId = `custom:${id}`;
    const newPinned = pinned.includes(feedId)
      ? pinned.filter((p) => p !== feedId)
      : [...pinned, feedId];
    setPinned(newPinned);
    storeData(PINNED_KEY, newPinned).catch(() => { });
  }, [id, pinned]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const f = await customFeedsService.get(String(id));
        if (cancelled) return;
        setFeed(f);
        setLikeCount(f.likeCount || 0);
        setIsLiked(f.isLiked || false);

        // Expand authors from members + lists
        const authors = new Set<string>(f.memberOxyUserIds || []);
        if (f.sourceListIds?.length) {
          await Promise.all(
            f.sourceListIds.map(async (lid: string) => {
              try {
                const l = await listsService.get(String(lid));
                (l.memberOxyUserIds || []).forEach((uid: string) => authors.add(uid));
              } catch { }
            })
          );
        }
        // Exclude owner unless explicitly added as member
        const ownerId = f.ownerOxyUserId;
        if (ownerId && !f.memberOxyUserIds?.includes(ownerId)) {
          authors.delete(ownerId);
        }
        if (!cancelled) setAuthorsCsv(Array.from(authors).join(','));
      } catch {
        if (!cancelled) setError('Failed to load feed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const isPinned = pinned.includes(`custom:${id}`);

  const onToggleLike = useCallback(async () => {
    if (isTogglingLike) return;
    setIsTogglingLike(true);
    const prevLiked = isLiked;
    const prevCount = likeCount;
    const newLiked = !prevLiked;
    setIsLiked(newLiked);
    setLikeCount(newLiked ? prevCount + 1 : Math.max(0, prevCount - 1));
    try {
      const result = newLiked
        ? await customFeedsService.likeFeed(String(id))
        : await customFeedsService.unlikeFeed(String(id));
      if (result.success) {
        setIsLiked(result.liked);
        setLikeCount(result.likeCount);
      } else {
        setIsLiked(prevLiked);
        setLikeCount(prevCount);
      }
    } catch {
      setIsLiked(prevLiked);
      setLikeCount(prevCount);
    } finally {
      setIsTogglingLike(false);
    }
  }, [id, isLiked, likeCount, isTogglingLike]);

  const onShare = useCallback(async () => {
    if (!feed) return;
    const url = `https://mention.earth/feeds/${id}`;
    try {
      await Share.share({
        message: `Check out "${feed.title}" on Mention!\n\n${url}`,
        url,
        title: `${feed.title} on Mention`,
      });
    } catch { }
  }, [feed, id]);

  const handleTabPress = useCallback((tabId: string) => {
    setActiveTab(tabId as FeedTab);
  }, []);

  const members: MemberProfile[] = feed?.members || [];
  const keywords: string[] = feed?.keywords || [];
  const memberAvatars: string[] = feed?.memberAvatars || [];
  const memberCount = feed?.memberCount ?? (feed?.memberOxyUserIds || []).length;
  const topicCount = feed?.topicCount ?? keywords.length;

  const feedFilters = useMemo(() => ({
    authors: authorsCsv,
    keywords: keywords.join(','),
    includeReplies: feed?.includeReplies,
    includeReposts: feed?.includeReposts,
    includeMedia: feed?.includeMedia,
    language: feed?.language,
    excludeOwner: true,
  }), [authorsCsv, keywords, feed?.includeReplies, feed?.includeReposts, feed?.includeMedia, feed?.language]);

  const tabBar = useMemo(() => (
    <AnimatedTabBar
      tabs={TABS}
      activeTabId={activeTab}
      onTabPress={handleTabPress}
      instanceId={`feed-detail-${id}`}
    />
  ), [activeTab, handleTabPress, id]);

  const listHeader = useMemo(() => {
    if (!feed) return null;
    return (
      <View>
        <FeedHero
          feed={feed}
          memberAvatars={memberAvatars}
          memberCount={memberCount}
          topicCount={topicCount}
          likeCount={likeCount}
          isLiked={isLiked}
          isTogglingLike={isTogglingLike}
          onShare={onShare}
          onToggleLike={onToggleLike}
        />
        {tabBar}
      </View>
    );
  }, [feed, memberAvatars, memberCount, topicCount, likeCount, isLiked, isTogglingLike, onShare, onToggleLike, tabBar]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: feed?.title || 'Feed',
          headerTitleStyle: { justifyContent: 'flex-start', flex: 1 },
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            <IconButton variant="icon" key="pin" onPress={onTogglePin}>
              <Ionicons name={isPinned ? 'pin' : 'pin-outline'} size={22} color={theme.colors.text} />
            </IconButton>,
            <IconButton variant="icon" key="share" onPress={onShare}>
              <Ionicons name="share-outline" size={22} color={theme.colors.text} />
            </IconButton>,
            <IconButton variant="icon" key="like" onPress={onToggleLike}>
              <Ionicons
                name={isLiked ? 'heart' : 'heart-outline'}
                size={22}
                color={isLiked ? theme.colors.primary : theme.colors.text}
              />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky={false}
      />

      {error ? (
        <View className="flex-1 items-center justify-center">
          <Text style={{ color: theme.colors.error || theme.colors.textSecondary }}>{error}</Text>
        </View>
      ) : loading ? (
        <View className="flex-1 items-center justify-center">
          <Text className="text-muted-foreground">Loading...</Text>
        </View>
      ) : activeTab === 'recent' ? (
        <Feed type="mixed" filters={feedFilters} listHeaderComponent={listHeader} />
      ) : (
        <ScrollView stickyHeaderIndices={[1]}>
          <FeedHero
            feed={feed}
            memberAvatars={memberAvatars}
            memberCount={memberCount}
            topicCount={topicCount}
            likeCount={likeCount}
            isLiked={isLiked}
            isTogglingLike={isTogglingLike}
            onShare={onShare}
            onToggleLike={onToggleLike}
          />
          {tabBar}
          {activeTab === 'profiles' && <ProfilesTab members={members} />}
          {activeTab === 'topics' && <TopicsTab keywords={keywords} />}
          {activeTab === 'reviews' && <ReviewsTab feedId={String(id)} />}
        </ScrollView>
      )}

      {/* FAB */}
      {!loading && !error && (
        <FAB
          onPress={() => router.push('/compose')}
          customIcon={<ComposeIcon size={22} className="text-primary-foreground" />}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  avatarGrid: {
    width: AVATAR_GRID_SIZE * 2 + AVATAR_GRID_GAP,
    height: AVATAR_GRID_SIZE * 2 + AVATAR_GRID_GAP,
  },
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
    ...StyleSheet.absoluteFillObject,
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
      web: { outlineStyle: 'none' as any },
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
