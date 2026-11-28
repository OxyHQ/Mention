import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import type { HydratedPost } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import Feed from '@/components/Feed/Feed';
import { usePostInteractions } from '@/components/Feed/postInteractions';
import { showRepostMenu } from '@/components/Feed/showRepostMenu';
import { FollowButton } from '@/components/FollowButton';
import PostActions from '@/components/Post/PostActions';
import { CompactReplyComposer } from '@/components/Post/CompactReplyComposer';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { Link, useRouter } from '@/lib/navigation/router';
import { usePostSelector } from '@/stores/postsStore';
import { videoPublicationDate, videoViewCount } from './videoMetadata';
import { postAcceptsReplies } from '@/utils/postReplies';

const useWatchDetails = create<{ post?: HydratedPost }>(() => ({}));

export function usePublishWatchDetails(post: HydratedPost | null | undefined, enabled: boolean) {
  useEffect(() => {
    if (!post || !enabled) return;
    useWatchDetails.setState({ post });
    return () => {
      if (useWatchDetails.getState().post === post) useWatchDetails.setState({ post: undefined });
    };
  }, [post, enabled]);
}

export function WatchVideoRail() {
  const post = useWatchDetails((state) => state.post);
  return post ? (
    <View className="px-4 pb-6 pt-3">
      <WatchVideoDetails key={post.id} post={post} />
    </View>
  ) : null;
}

export function WatchVideoDetails({ post }: { post: HydratedPost }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const { user } = useAuth();
  const router = useRouter();
  const interactions = usePostInteractions();
  const current = usePostSelector(post.id) ?? post;
  const { engagement, viewerState } = current;
  const [showReplies, setShowReplies] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const description = post.content.text?.trim();
  const caption = description?.split('\n')[0];
  const canExpand = Boolean(
    description && (description.length > 110 || description.split('\n').length > 3),
  );
  const title =
    post.content.title?.trim() || caption || t('videos.reel', { defaultValue: 'Video' });
  const handle = getNormalizedUserHandle(post.user);
  const author = post.user.name?.displayName || (handle ? `@${handle}` : '');
  const profile = profileHrefForUser(post.user);
  const { relative, absolute } = videoPublicationDate(post.metadata.createdAt, locale);
  const views = videoViewCount(t, locale, engagement.views);
  const metadata = [views, relative].filter(Boolean).join(' · ');
  const byline = (
    <>
      <Avatar source={post.user.avatar ?? undefined} size={36} variant={MEDIA_VARIANT_AVATAR} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-semibold text-foreground">
          {author}
        </Text>
        {handle && author !== `@${handle}` ? (
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            @{handle}
          </Text>
        ) : null}
      </View>
    </>
  );

  return (
    <View className="gap-3" testID="watch-video-details">
      <Text
        accessibilityRole="header"
        numberOfLines={post.content.title ? undefined : 3}
        className="text-[22px] font-bold leading-7 text-foreground"
      >
        {title}
      </Text>
      {metadata ? (
        <Text testID="watch-video-metadata" className="text-sm font-medium text-muted-foreground">
          {metadata}
        </Text>
      ) : null}
      {description && (description !== title || !post.content.title) ? (
        <View className="gap-1" testID="watch-video-description">
          <LinkifiedText
            text={description}
            numberOfLines={expanded || !canExpand ? undefined : 3}
            className="text-sm leading-5 text-foreground"
          />
          {expanded && absolute && absolute !== relative ? (
            <Text className="text-xs text-muted-foreground">{absolute}</Text>
          ) : null}
          {canExpand ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((value) => !value)}
            >
              <Text className="text-xs font-semibold text-foreground">
                {expanded
                  ? t('common.showLess', { defaultValue: 'Show less' })
                  : t('common.showMore', { defaultValue: 'Show more' })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {author ? (
        <View className="flex-row items-center gap-2">
          {profile ? (
            <Link href={profile} asChild>
              <Pressable
                accessibilityRole="link"
                className="min-w-0 flex-1 flex-row items-center gap-2.5 py-1"
              >
                {byline}
              </Pressable>
            </Link>
          ) : (
            <View className="min-w-0 flex-1 flex-row items-center gap-2.5 py-1">{byline}</View>
          )}
          {post.user.id && post.user.id !== user?.id ? (
            <FollowButton userId={post.user.id} username={handle ?? undefined} size="sm" />
          ) : null}
        </View>
      ) : null}
      <View testID="watch-video-actions">
        <PostActions
          t={t}
          engagement={{
            likes: engagement.likes,
            replies: engagement.replies,
            boosts: engagement.reposts,
            saves: engagement.saves,
          }}
          isLiked={viewerState.isLiked}
          isDownvoted={viewerState.isDownvoted}
          isBoosted={viewerState.isReposted}
          isSaved={viewerState.isSaved}
          onLike={() => {
            if (!interactions.requireSession()) return false;
            void interactions.toggleLike(current, 'videos');
            return true;
          }}
          onDownvote={() => void interactions.toggleDownvote(current)}
          onReply={
            postAcceptsReplies(current) || (engagement.replies ?? 0) > 0
              ? () => setShowReplies((open) => !open)
              : undefined
          }
          onRepost={() => {
            if (!interactions.requireSession()) return;
            showRepostMenu({
              isBoosted: Boolean(viewerState.isReposted),
              quotesDisabled: Boolean(current.metadata.quotesDisabled),
              t,
              onRepost: () => void interactions.toggleRepost(current, 'videos'),
              onQuote: () =>
                router.push({ pathname: '/compose', params: { quotePostId: post.id } }),
            });
          }}
          onSave={() => void interactions.toggleSave(current, 'videos')}
          onShare={() => interactions.share(current)}
          onSendInAllo={() => interactions.sendInAllo(post.id)}
        />
      </View>
      {showReplies ? (
        <View className="gap-3 border-t border-border pt-3" testID="watch-video-replies">
          <View className="flex-row items-center justify-between">
            <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
              {t('videos.replies')}
            </Text>
            <Button
              size="sm"
              appearance="subtle"
              tone="neutral"
              onPress={() => setShowReplies(false)}
            >
              {t('common.close')}
            </Button>
          </View>
          {user && postAcceptsReplies(current) ? (
            <CompactReplyComposer key={user.id} postId={post.id} />
          ) : null}
          <Feed type="replies" filters={{ postId: post.id, parentPostId: post.id }} hideHeader />
        </View>
      ) : null}
    </View>
  );
}
