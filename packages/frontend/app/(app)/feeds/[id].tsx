import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share, Platform } from 'react-native';
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
import { CreateIcon } from '@/assets/icons/create-icon';
import Avatar from '@/components/Avatar';
import { getData, storeData } from '@/utils/storage';
import { formatCompactNumber } from '@/utils/formatNumber';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import * as OxyServicesNS from '@oxyhq/services';

const PINNED_KEY = 'mention.pinnedFeeds';

type FeedTab = 'recent' | 'profiles' | 'topics';

interface MemberProfile {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
}

const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{ userId: string }>;

const TABS = [
  { id: 'recent', label: 'Recent' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'topics', label: 'Topics' },
];

// 2x2 avatar grid matching Threads design
const AvatarGrid = React.memo(function AvatarGrid({ avatars }: { avatars: string[] }) {
  if (!avatars.length) return null;
  const displayed = avatars.slice(0, 4);
  const size = 38;
  const gap = 3;

  return (
    <View style={{ width: size * 2 + gap, height: size * 2 + gap }}>
      {displayed.map((uri, i) => (
        <View
          key={`${uri}-${i}`}
          style={{
            position: 'absolute',
            top: i < 2 ? 0 : size + gap,
            left: i % 2 === 0 ? 0 : size + gap,
          }}
        >
          <Avatar source={uri} size={size} />
        </View>
      ))}
    </View>
  );
});

export default function CustomFeedTimelineScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [feed, setFeed] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authorsCsv, setAuthorsCsv] = useState<string>('');
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
    (async () => {
      try {
        const f = await customFeedsService.get(String(id));
        setFeed(f);
        setLikeCount(f.likeCount || 0);
        setIsLiked(f.isLiked || false);
        // Expand authors from members + lists
        let authors = new Set<string>(f.memberOxyUserIds || []);
        if (f.sourceListIds && f.sourceListIds.length) {
          for (const lid of f.sourceListIds) {
            try {
              const l = await listsService.get(String(lid));
              (l.memberOxyUserIds || []).forEach((uid: string) => authors.add(uid));
            } catch { }
          }
        }
        const ownerId = f.ownerOxyUserId;
        if (ownerId && !f.memberOxyUserIds?.includes(ownerId)) {
          authors.delete(ownerId);
        }
        setAuthorsCsv(Array.from(authors).join(','));
      } catch {
        setError('Failed to load feed');
      } finally {
        setLoading(false);
      }
    })();
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

  const members: MemberProfile[] = feed?.members || [];
  const keywords: string[] = feed?.keywords || [];
  const memberAvatars: string[] = feed?.memberAvatars || [];
  const memberCount = feed?.memberCount ?? (feed?.memberOxyUserIds || []).length;
  const topicCount = feed?.topicCount ?? keywords.length;

  const heroSection = feed ? (
    <View style={styles.hero}>
      {/* Title row with avatar grid */}
      <View style={styles.titleRow}>
        <View style={styles.titleInfo}>
          <Text style={[styles.title, { color: theme.colors.text }]}>{feed.title}</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
            {topicCount > 0 && `${topicCount} ${topicCount === 1 ? 'topic' : 'topics'}`}
            {topicCount > 0 && memberCount > 0 && ' \u00B7 '}
            {memberCount > 0 && `${memberCount} ${memberCount === 1 ? 'profile' : 'profiles'}`}
          </Text>
        </View>
        {memberAvatars.length > 0 && <AvatarGrid avatars={memberAvatars} />}
      </View>

      {/* Description */}
      {feed.description ? (
        <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
          {feed.description}
        </Text>
      ) : null}

      {/* Meta line */}
      <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
        {feed.owner && `Feed by ${feed.owner.displayName || feed.owner.username}`}
        {likeCount > 0 && (
          <>
            {feed.owner ? ' \u00B7 ' : ''}
            Pinned by {formatCompactNumber(likeCount)}
          </>
        )}
      </Text>

      {/* Action buttons */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.colors.border }]}
          onPress={onShare}
          activeOpacity={0.7}
        >
          <Text style={[styles.actionBtnText, { color: theme.colors.text }]}>Share feed</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { borderColor: theme.colors.border }]}
          onPress={onToggleLike}
          disabled={isTogglingLike}
          activeOpacity={0.7}
        >
          <Text style={[styles.actionBtnText, { color: theme.colors.text }]}>
            {isLiked ? 'Pinned' : 'Pin feed'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: feed?.title || 'Feed',
          headerTitleStyle: { justifyContent: 'flex-start', flex: 1 },
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
          rightComponents: [
            <IconButton variant="icon" key="pin" onPress={onTogglePin}>
              <Ionicons name={isPinned ? 'pin' : 'pin-outline'} size={22} color={theme.colors.text} />
            </IconButton>,
            <IconButton variant="icon" key="share" onPress={onShare}>
              <Ionicons name="share-outline" size={22} color={theme.colors.text} />
            </IconButton>,
            <IconButton variant="icon" key="more" onPress={onToggleLike}>
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
        <View style={styles.center}>
          <Text style={{ color: theme.colors.error || theme.colors.textSecondary }}>{error}</Text>
        </View>
      ) : loading ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.textSecondary }}>Loading...</Text>
        </View>
      ) : (
        <>
          {/* Hero + Tabs + Content */}
          {activeTab === 'recent' ? (
            <Feed
              type="mixed"
              filters={{
                authors: authorsCsv,
                keywords: keywords.join(','),
                includeReplies: feed?.includeReplies,
                includeReposts: feed?.includeReposts,
                includeMedia: feed?.includeMedia,
                language: feed?.language,
                excludeOwner: true,
              }}
              listHeaderComponent={
                <View>
                  {heroSection}
                  <AnimatedTabBar
                    tabs={TABS}
                    activeTabId={activeTab}
                    onTabPress={(tabId) => setActiveTab(tabId as FeedTab)}
                    instanceId={`feed-detail-${id}`}
                  />
                </View>
              }
            />
          ) : (
            <View style={styles.container}>
              {/* For non-Recent tabs, render hero + tabs in a scroll-less header, then tab content */}
              {heroSection}
              <AnimatedTabBar
                tabs={TABS}
                activeTabId={activeTab}
                onTabPress={(tabId) => setActiveTab(tabId as FeedTab)}
                instanceId={`feed-detail-${id}`}
              />
              {activeTab === 'profiles' && (
                <ProfilesTab members={members} theme={theme} />
              )}
              {activeTab === 'topics' && (
                <TopicsTab keywords={keywords} theme={theme} />
              )}
            </View>
          )}

          {/* FAB */}
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: theme.colors.primary }]}
            onPress={() => router.push('/compose')}
            activeOpacity={0.8}
          >
            <CreateIcon size={22} color={theme.colors.card} />
          </TouchableOpacity>
        </>
      )}
    </ThemedView>
  );
}

// Profiles tab — member list with follow buttons
const ProfilesTab = React.memo(function ProfilesTab({
  members,
  theme,
}: {
  members: MemberProfile[];
  theme: any;
}) {
  if (members.length === 0) {
    return (
      <View style={styles.emptyTab}>
        <Ionicons name="people-outline" size={40} color={theme.colors.textSecondary} />
        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No profiles yet</Text>
      </View>
    );
  }

  return (
    <View style={styles.profilesList}>
      {members.map((m) => (
        <TouchableOpacity
          key={m.id}
          style={styles.profileRow}
          onPress={() => router.push(`/@${m.username}` as any)}
          activeOpacity={0.7}
        >
          <Avatar source={m.avatar} size={44} />
          <View style={styles.profileInfo}>
            <Text style={[styles.profileUsername, { color: theme.colors.text }]} numberOfLines={1}>
              {m.username}
            </Text>
            <Text style={[styles.profileName, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {m.displayName}
            </Text>
          </View>
          {FollowButton && <FollowButton userId={m.id} />}
        </TouchableOpacity>
      ))}
    </View>
  );
});

// Topics tab — keyword list
const TopicsTab = React.memo(function TopicsTab({
  keywords,
  theme,
}: {
  keywords: string[];
  theme: any;
}) {
  if (keywords.length === 0) {
    return (
      <View style={styles.emptyTab}>
        <Ionicons name="pricetag-outline" size={40} color={theme.colors.textSecondary} />
        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>No topics yet</Text>
      </View>
    );
  }

  return (
    <View style={styles.topicsList}>
      {keywords.map((keyword) => (
        <View key={keyword} style={[styles.topicRow, { borderBottomColor: theme.colors.border }]}>
          <View style={[styles.topicIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <Ionicons name="pricetag" size={18} color={theme.colors.textSecondary} />
          </View>
          <Text style={[styles.topicText, { color: theme.colors.text }]}>{keyword}</Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Hero section
  hero: {
    padding: 20,
    gap: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  titleInfo: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    lineHeight: 32,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 20,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
  },
  meta: {
    fontSize: 14,
    lineHeight: 18,
  },
  // Action buttons
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
    ...Platform.select({
      web: { boxShadow: '0px 2px 6px 0px rgba(0, 0, 0, 0.12)' },
      default: {},
    }),
  },
  // Profiles tab
  profilesList: {
    padding: 16,
    gap: 4,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  profileInfo: {
    flex: 1,
    gap: 2,
  },
  profileUsername: {
    fontSize: 15,
    fontWeight: '600',
  },
  profileName: {
    fontSize: 14,
  },
  // Topics tab
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
  topicIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topicText: {
    fontSize: 16,
    fontWeight: '500',
  },
  // Empty states
  emptyTab: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
