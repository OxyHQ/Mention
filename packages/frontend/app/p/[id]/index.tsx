import Feed from "@/components/Feed";
import { Header } from "@/components/Header";
import Post from "@/components/Post";
import { Post as IPost } from "@/interfaces/Post";
import { colors } from "@/styles/colors";
import api from "@/utils/api";
import { useLocalSearchParams, router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  RefreshControl,
  Platform,
  useWindowDimensions
} from "react-native";
import { useTranslation } from "react-i18next";
import { useOxy } from "@oxyhq/services/full";
import Avatar from "@/components/Avatar";
import { format } from "date-fns";
import MediaGrid from "@/components/Post/MediaGrid";

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const { width: windowWidth } = useWindowDimensions();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [post, setPost] = useState<IPost | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Calculate responsive values
  const isTabletOrDesktop = windowWidth >= 768;

  const fetchPost = async (showRefresh = false) => {
    try {
      if (showRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      const response = await api.get(`feed/post/${id}`);
      setPost(response.data.data || response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load post');
      console.error('Error fetching post:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (id) {
      fetchPost();
    }
  }, [id]);

  const handleRefresh = () => {
    fetchPost(true);
  };

  const handleReply = () => {
    if (!isAuthenticated) {
      // Could show sign-in modal here
      return;
    }
    router.push(`/p/${id}/reply`);
  };



  const formatFullDate = (dateString: string) => {
    return format(new Date(dateString), 'h:mm a · MMM d, yyyy');
  };

  const getAuthorDisplayName = () => {
    if (!post?.author) return t('Unknown');

    if (post.author.name) {
      if (typeof post.author.name === 'object') {
        const { first, last } = post.author.name;
        return `${first} ${last || ''}`.trim();
      } else {
        return post.author.name;
      }
    }

    return post.author.username || t('Unknown');
  };

  const formatLocation = (location: any) => {
    if (typeof location === 'string') {
      return location;
    }
    if (location && typeof location === 'object' && location.type === 'Point') {
      return `${location.coordinates[1]}, ${location.coordinates[0]}`;
    }
    return '';
  };

  if (loading && !refreshing) {
    return (
      <View style={styles.container}>
        <Header
          options={{
            title: t('Post'),
            showBackButton: true
          }}
        />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primaryColor} />
          <Text style={styles.loadingText}>{t('Loading post...')}</Text>
        </View>
      </View>
    );
  }

  if (error || !post) {
    return (
      <View style={styles.container}>
        <Header
          options={{
            title: t('Post not found'),
            showBackButton: true
          }}
        />
        <View style={styles.errorContainer}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorTitle}>
            {error ? t('Failed to load post') : t('Post not found')}
          </Text>
          <Text style={styles.errorText}>
            {error || t('This post may have been deleted or is not available')}
          </Text>
          <TouchableOpacity onPress={() => fetchPost()} style={styles.retryButton}>
            <Text style={styles.retryText}>{t('Try again')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Header
        options={{
          title: t('Post'),
          showBackButton: true
        }}
      />

      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[colors.primaryColor]}
            tintColor={colors.primaryColor}
          />
        }
        contentContainerStyle={[
          styles.scrollContent,
          isTabletOrDesktop && styles.scrollContentTablet
        ]}
      >
        {/* Main Post Detail */}
        <View style={[styles.postContainer, isTabletOrDesktop && styles.postContainerTablet]}>
          {/* Author Info */}
          <View style={styles.authorSection}>
            <TouchableOpacity
              style={styles.authorInfo}
              onPress={() => router.push(`/@${post.author?.username}`)}
            >
              <Avatar id={post.author?.avatar} size={48} />
              <View style={styles.authorText}>
                <View style={styles.authorNameRow}>
                  <Text style={styles.authorName}>{getAuthorDisplayName()}</Text>
                  {post.author?.labels?.includes('verified') && (
                    <Text style={styles.verifiedBadge}>✓</Text>
                  )}
                  {post.author?.premium?.isPremium && (
                    <Text style={styles.premiumBadge}>⭐</Text>
                  )}
                </View>
                <Text style={styles.authorUsername}>@{post.author?.username}</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Post Content */}
          <View style={styles.contentSection}>
            <Text style={styles.postText}>{post.text}</Text>

            {/* Media */}
            {post.media && post.media.length > 0 && (
              <View style={styles.mediaContainer}>
                <MediaGrid
                  media={post.media}
                  onMediaPress={(media, index) => {
                    // Handle media press - could open full screen viewer
                    console.log('Media pressed:', media, index);
                  }}
                />
              </View>
            )}

            {/* Location */}
            {post.location && (
              <View style={styles.locationContainer}>
                <Text style={styles.locationIcon}>📍</Text>
                <Text style={styles.locationText}>{formatLocation(post.location)}</Text>
              </View>
            )}
          </View>

          {/* Timestamp */}
          <View style={styles.timestampSection}>
            <Text style={styles.timestamp}>
              {formatFullDate(post.created_at)}
            </Text>
          </View>

          {/* Engagement Stats */}
          <View style={styles.statsSection}>
            {(post._count?.replies ?? 0) > 0 && (
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{post._count?.replies}</Text>
                <Text style={styles.statLabel}>
                  {(post._count?.replies ?? 0) === 1 ? t('Reply') : t('Replies')}
                </Text>
              </View>
            )}
            {(post._count?.reposts ?? 0) > 0 && (
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{post._count?.reposts}</Text>
                <Text style={styles.statLabel}>
                  {(post._count?.reposts ?? 0) === 1 ? t('Repost') : t('Reposts')}
                </Text>
              </View>
            )}
            {(post._count?.likes ?? 0) > 0 && (
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{post._count?.likes}</Text>
                <Text style={styles.statLabel}>
                  {(post._count?.likes ?? 0) === 1 ? t('Like') : t('Likes')}
                </Text>
              </View>
            )}
            {(post._count?.bookmarks ?? 0) > 0 && (
              <View style={styles.statItem}>
                <Text style={styles.statNumber}>{post._count?.bookmarks}</Text>
                <Text style={styles.statLabel}>
                  {(post._count?.bookmarks ?? 0) === 1 ? t('Bookmark') : t('Bookmarks')}
                </Text>
              </View>
            )}
          </View>

          {/* Action Buttons */}
          <View style={styles.actionsSection}>
            <Post postData={post} showActions={true} />
          </View>

          {/* Reply Button */}
          {isAuthenticated && (
            <TouchableOpacity style={styles.replyButton} onPress={handleReply}>
              <Text style={styles.replyButtonText}>{t('Reply to this post')}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Replies Section */}
        <View style={styles.repliesSection}>
          <View style={styles.repliesHeader}>
            <Text style={styles.repliesTitle}>{t('Replies')}</Text>
          </View>
          <Feed
            type="replies"
            parentId={post.id}
            showCreatePost={false}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },
  scrollContentTablet: {
    paddingHorizontal: Platform.OS === 'web' ? '10%' : 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.primaryDark,
    marginBottom: 8,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_3,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  retryButton: {
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  retryText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  postContainer: {
    backgroundColor: 'white',
    borderRadius: 12,
    margin: 16,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  postContainerTablet: {
    borderRadius: 16,
    shadowRadius: 6,
    elevation: 4,
  },
  authorSection: {
    padding: 20,
    paddingBottom: 16,
  },
  authorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  authorText: {
    marginLeft: 12,
    flex: 1,
  },
  authorNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  authorName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.primaryDark,
  },
  verifiedBadge: {
    fontSize: 16,
    color: colors.primaryColor,
  },
  premiumBadge: {
    fontSize: 14,
  },
  authorUsername: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_3,
    marginTop: 2,
  },
  contentSection: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  postText: {
    fontSize: 18,
    lineHeight: 26,
    color: colors.primaryDark,
    marginBottom: 12,
  },
  mediaContainer: {
    marginTop: 12,
  },
  locationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 6,
  },
  locationIcon: {
    fontSize: 16,
  },
  locationText: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  timestampSection: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  timestamp: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  statsSection: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    gap: 20,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statNumber: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.primaryDark,
  },
  statLabel: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  actionsSection: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  replyButton: {
    margin: 20,
    marginTop: 16,
    backgroundColor: colors.primaryColor,
    paddingVertical: 14,
    borderRadius: 24,
    alignItems: 'center',
  },
  replyButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  repliesSection: {
    marginTop: 8,
  },
  repliesHeader: {
    backgroundColor: 'white',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    marginHorizontal: 16,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  repliesTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.primaryDark,
  },
});
