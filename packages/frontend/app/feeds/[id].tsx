import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import Feed from '@/components/Feed/Feed';
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import { getData, storeData } from '@/utils/storage';
import { ThemedText } from '@/components/ThemedText';
import { formatCompactNumber } from '@/utils/formatNumber';

const PINNED_KEY = 'mention.pinnedFeeds';

export default function CustomFeedTimelineScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [feed, setFeed] = useState<any | null>(null);
  const [_loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authorsCsv, setAuthorsCsv] = useState<string>('');
  const [showDetails, setShowDetails] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [isTogglingLike, setIsTogglingLike] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = (await getData<string[]>(PINNED_KEY)) || [];
        setPinned(stored);
      } catch { }
    })();
  }, []);

  const onTogglePin = async () => {
    const feedId = `custom:${id}`;
    const newPinned = pinned.includes(feedId)
      ? pinned.filter((p) => p !== feedId)
      : [...pinned, feedId];
    setPinned(newPinned);
    storeData(PINNED_KEY, newPinned).catch(() => { });
  };

  useEffect(() => {
    (async () => {
      try {
        const f = await customFeedsService.get(String(id));
        setFeed(f);
        setLikeCount(f.likeCount || 0);
        setIsLiked(f.isLiked || false);
        // Only include explicitly added members, NOT the owner unless they're in the list
        let authors = new Set<string>(f.memberOxyUserIds || []);
        if (f.sourceListIds && f.sourceListIds.length) {
          for (const lid of f.sourceListIds) {
            try {
              const l = await listsService.get(String(lid));
              (l.memberOxyUserIds || []).forEach((uid: string) => authors.add(uid));
            } catch { }
          }
        }
        // Explicitly remove owner if they're not in the member list
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

  const onToggleLike = async () => {
    if (isTogglingLike) return;

    setIsTogglingLike(true);
    const previousIsLiked = isLiked;
    const previousLikeCount = likeCount;

    // Optimistic update
    const newIsLiked = !previousIsLiked;
    const newLikeCount = newIsLiked ? previousLikeCount + 1 : Math.max(0, previousLikeCount - 1);
    setIsLiked(newIsLiked);
    setLikeCount(newLikeCount);

    try {
      const result = newIsLiked
        ? await customFeedsService.likeFeed(String(id))
        : await customFeedsService.unlikeFeed(String(id));

      // Update with server response
      if (result.success) {
        setIsLiked(result.liked);
        setLikeCount(result.likeCount);
      } else {
        // Rollback on failure
        setIsLiked(previousIsLiked);
        setLikeCount(previousLikeCount);
      }
    } catch (error) {
      console.error('Error toggling like:', error);
      // Rollback on error
      setIsLiked(previousIsLiked);
      setLikeCount(previousLikeCount);
    } finally {
      setIsTogglingLike(false);
    }
  };

  return (
    <ThemedView style={{ flex: 1 }}>
      <Header
        options={{
          title: feed?.title || 'Feed',
          subtitle: feed ? (
            <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
              {feed.owner ? `@${feed.owner.username || feed.owner.handle}` : feed.ownerOxyUserId ? `@${feed.ownerOxyUserId}` : ''}
              {feed?.likeCount !== undefined && likeCount > 0 && (
                <>
                  {(feed.owner || feed.ownerOxyUserId) ? ' • ' : ''}
                  <Ionicons name="heart" size={10} color={theme.colors.textSecondary} />
                  {' '}{formatCompactNumber(likeCount)}
                </>
              )}
            </Text>
          ) : undefined,
          headerTitleStyle: { justifyContent: 'flex-start', flex: 1 },
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
            <Avatar key="avatar" source={feed?.avatar} size={32} style={{ borderRadius: 4, marginLeft: -4 }} />,
          ],
          rightComponents: [
            <HeaderIconButton key="more" onPress={() => setShowDetails(true)}>
              <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
            </HeaderIconButton>,
            <HeaderIconButton key="pin" onPress={onTogglePin}>
              <Ionicons name={isPinned ? "pin" : "pin-outline"} size={24} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={false}
        disableSticky={false}
      />

      {error ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.error || theme.colors.textSecondary }}>{error}</Text>
        </View>
      ) : !feed ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text }}>Loading…</Text>
        </View>
      ) : (
        <>
          <Feed
            type="mixed"
            filters={{
              authors: authorsCsv,
              keywords: (feed.keywords || []).join(','),
              includeReplies: feed.includeReplies,
              includeReposts: feed.includeReposts,
              includeMedia: feed.includeMedia,
              language: feed.language,
              excludeOwner: true,
            }}
            listHeaderComponent={null}
          />

          {/* FAB */}
          <TouchableOpacity
            style={[styles.fab, { backgroundColor: theme.colors.primary }]}
            onPress={() => router.push('/compose')}
            activeOpacity={0.8}
          >
            <Ionicons name="create-outline" size={24} color={theme.colors.card} />
          </TouchableOpacity>

          {/* Details Modal */}
          <Modal
            visible={showDetails}
            transparent
            animationType="fade"
            onRequestClose={() => setShowDetails(false)}
          >
            <TouchableOpacity
              style={styles.modalOverlay}
              activeOpacity={1}
              onPress={() => setShowDetails(false)}
            >
              <TouchableOpacity
                activeOpacity={1}
                style={[styles.modalContent, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
              >
                <View style={styles.modalHeader}>
                  <Avatar source={feed.avatar} size={48} style={{ borderRadius: 8 }} />
                  <View style={{ flex: 1 }}>
                    <ThemedText type="defaultSemiBold" style={{ fontSize: 18 }}>{feed.title}</ThemedText>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>
                      By @{feed.owner?.username || feed.owner?.handle || 'unknown'}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => {
                    // Share logic here
                  }}>
                    <Ionicons name="share-outline" size={24} color={theme.colors.text} />
                  </TouchableOpacity>
                </View>

                {feed.description ? (
                  <Text style={[styles.modalDesc, { color: theme.colors.text }]}>
                    {feed.description}
                  </Text>
                ) : null}

                <Text style={[styles.likesCount, { color: theme.colors.textSecondary }]}>
                  Liked by {likeCount} {likeCount === 1 ? 'user' : 'users'}
                </Text>

                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={[
                      styles.modalBtn,
                      {
                        backgroundColor: isLiked ? theme.colors.primary : theme.colors.backgroundSecondary,
                        borderWidth: isLiked ? 0 : 1,
                        borderColor: theme.colors.border,
                      }
                    ]}
                    onPress={onToggleLike}
                    disabled={isTogglingLike}
                  >
                    <Ionicons
                      name={isLiked ? 'heart' : 'heart-outline'}
                      size={20}
                      color={isLiked ? theme.colors.card : theme.colors.text}
                    />
                    <Text style={[
                      styles.modalBtnText,
                      { color: isLiked ? theme.colors.card : theme.colors.text }
                    ]}>
                      {isLiked ? 'Liked' : 'Like'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.modalBtn, { backgroundColor: isPinned ? theme.colors.backgroundSecondary : theme.colors.primary }]}
                    onPress={onTogglePin}
                  >
                    <Text style={[styles.modalBtnText, { color: isPinned ? theme.colors.text : theme.colors.card }]}>
                      {isPinned ? 'Unpin feed' : 'Pin feed'}
                    </Text>
                    {!isPinned && <Ionicons name="pin" size={16} color={theme.colors.card} style={{ marginLeft: 4 }} />}
                  </TouchableOpacity>
                </View>

                <View style={[styles.modalFooter, { borderTopColor: theme.colors.border }]}>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>
                    Something wrong? Let us know.
                  </Text>
                  <TouchableOpacity style={[styles.reportBtn, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <Text style={{ color: theme.colors.text, fontSize: 13, fontWeight: '500' }}>Report feed</Text>
                    <Ionicons name="information-circle-outline" size={14} color={theme.colors.text} style={{ marginLeft: 4 }} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </TouchableOpacity>
          </Modal>
        </>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
  },
  hashtagCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  hashtag: {
    fontSize: 40,
    fontWeight: 'bold',
  },
  emptyText: {
    fontSize: 16,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    boxShadow: '0px 2px 4px 0px rgba(0, 0, 0, 0.25)',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-start', // Align to top to simulate header dropdown or just center
    paddingTop: 100, // Adjust based on header height
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    boxShadow: '0px 4px 8px 0px rgba(0, 0, 0, 0.3)',
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  modalDesc: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  likesCount: {
    fontSize: 14,
    marginBottom: 16,
    textDecorationLine: 'underline',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  modalBtn: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  modalBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  modalFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  reportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
});
