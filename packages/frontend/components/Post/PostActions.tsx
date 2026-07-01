import React, { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Ionicons } from '@expo/vector-icons';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { BoostIcon, BoostIconActive } from '@/assets/icons/boost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Avatar } from '@oxyhq/bloom/avatar';

import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@/hooks/useHaptics';
import { formatCompactNumber } from '@/utils/formatNumber';
import { PressableScale } from '@/lib/animations/PressableScale';
import { AnimatedLikeIcon } from '@/lib/animations/AnimatedLikeIcon';
import { CountWheel } from '@/lib/animations/CountWheel';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import VotePill from './VotePill';

const ICON_SIZE = 20;
// The focused post-detail variant uses larger icons spread across the full row.
const DETAIL_ICON_SIZE = 22;
const MINI_AVATAR = 16;
const AVATAR_OVERLAP = -4;

interface Engagement {
  replies: number | null;
  boosts: number | null;
  likes: number | null;
  downvotes?: number | null;
  saves?: number | null;
  views?: number | null;
  recentReplierAvatars?: string[];
}

interface Props {
  engagement: Engagement;
  isLiked?: boolean;
  isDownvoted?: boolean;
  isBoosted?: boolean;
  isSaved?: boolean;
  onReply: () => void;
  onBoost: () => void;
  onLike: () => void;
  onDownvote?: () => void;
  onSave: () => void;
  onShare: () => void;
  onLikesPress?: () => void;
  onBoostsPress?: () => void;
  onInsightsPress?: () => void;
  onTranslate?: () => void;
  isTranslated?: boolean;
  isTranslating?: boolean;
  isPremium?: boolean;
  postId?: string;
  /**
   * Focused post-detail variant: a full-width spread-out action bar with inline
   * counts, preceded by the full absolute timestamp row and a tappable
   * engagement-stats summary. The feed (default) renders the compact icon row.
   */
  detail?: boolean;
  /** Full absolute timestamp (detail variant only), e.g. "9:20 PM · Jun 11, 2026". */
  timestampLabel?: string;
  /** Whether this post has attachments above the bar — controls the top border on the timestamp row. */
  hasMediaBlock?: boolean;
}

const PostActions: React.FC<Props> = ({
  engagement,
  isLiked,
  isDownvoted,
  isBoosted,
  isSaved,
  onReply,
  onBoost,
  onLike,
  onDownvote,
  onSave,
  onShare,
  onLikesPress,
  onBoostsPress,
  onInsightsPress,
  onTranslate,
  isTranslated,
  isTranslating,
  isPremium,
  detail = false,
  timestampLabel,
  hasMediaBlock = false,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  const hasBeenToggled = useRef(false);
  const voteStyle = useVoteStyle();

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const boosts = engagement?.boosts ?? 0;
  const saves = engagement?.saves ?? 0;
  const downvotes = engagement?.downvotes ?? 0;
  const replierAvatars = engagement?.recentReplierAvatars ?? [];

  if (detail) {
    // Engagement-stats summary entries (boosts · likes · saves), tappable to open
    // the engagement-list sheet where a handler is provided.
    const statsEntries: { key: string; label: string; count: number; onPress?: () => void }[] = [];
    if (boosts > 0) statsEntries.push({ key: 'boosts', label: boosts === 1 ? 'boost' : 'boosts', count: boosts, onPress: onBoostsPress });
    if (likes > 0) statsEntries.push({ key: 'likes', label: likes === 1 ? 'like' : 'likes', count: likes, onPress: onLikesPress });
    if (saves > 0) statsEntries.push({ key: 'saves', label: saves === 1 ? 'save' : 'saves', count: saves });

    return (
      <View>
        {/* Full absolute timestamp row */}
        {timestampLabel ? (
          <View
            className="flex-row items-center py-3 border-border"
            style={{ borderTopWidth: hasMediaBlock ? 0 : StyleSheet.hairlineWidth }}
          >
            <Text className="text-muted-foreground text-[14px]">{timestampLabel}</Text>
            <Ionicons name="globe-outline" size={14} color={theme.colors.textSecondary} style={{ marginLeft: 6 }} />
          </View>
        ) : null}

        {/* Engagement stats row */}
        {statsEntries.length > 0 && (
          <View className="flex-row items-center py-3 border-border" style={{ borderTopWidth: StyleSheet.hairlineWidth, gap: 16 }}>
            {statsEntries.map((stat) => (
              <PressableScale
                key={stat.key}
                className="flex-row items-center"
                style={{ gap: 4 }}
                onPress={stat.onPress}
                disabled={!stat.onPress}
              >
                <Text className="text-foreground text-[14px] font-bold">{formatCompactNumber(stat.count)}</Text>
                <Text className="text-muted-foreground text-[14px]">{stat.label}</Text>
              </PressableScale>
            ))}
          </View>
        )}

        {/* Action buttons row — spread across the full width */}
        <View className="flex-row items-center justify-between py-2.5 border-border" style={{ borderTopWidth: StyleSheet.hairlineWidth }}>
          {voteStyle === 'pill' && onDownvote ? (
            <VotePill
              likeCount={likes}
              downvoteCount={downvotes}
              isLiked={!!isLiked}
              isDownvoted={!!isDownvoted}
              onUpvote={() => {
                hasBeenToggled.current = true;
                onLike();
              }}
              onDownvote={onDownvote}
            />
          ) : (
            <PressableScale
              className="flex-row items-center"
              style={{ gap: 6 }}
              onPress={() => {
                hasBeenToggled.current = true;
                haptic('Light');
                onLike();
              }}
              hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
            >
              <AnimatedLikeIcon isLiked={!!isLiked} hasBeenToggled={hasBeenToggled.current} />
              {likes > 0 && <CountWheel likeCount={likes} isLiked={!!isLiked} hasBeenToggled={hasBeenToggled.current} />}
            </PressableScale>
          )}

          <PressableScale
            className="flex-row items-center"
            style={{ gap: 6 }}
            onPress={() => {
              haptic('Light');
              onReply();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Reply"
          >
            <CommentIcon size={DETAIL_ICON_SIZE} className="text-muted-foreground" />
            {replies > 0 && <Text className="text-muted-foreground text-[13px]">{formatCompactNumber(replies)}</Text>}
          </PressableScale>

          <PressableScale
            className="flex-row items-center"
            style={{ gap: 6 }}
            onPress={() => {
              haptic('Medium');
              onBoost();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isBoosted ? 'Undo boost' : 'Boost'}
          >
            {isBoosted ? (
              <BoostIconActive size={DETAIL_ICON_SIZE} color={theme.colors.success} />
            ) : (
              <BoostIcon size={DETAIL_ICON_SIZE} className="text-muted-foreground" />
            )}
            {boosts > 0 && (
              <Text
                className={isBoosted ? 'text-[13px]' : 'text-[13px] text-muted-foreground'}
                style={isBoosted ? { color: theme.colors.success } : undefined}
              >
                {formatCompactNumber(boosts)}
              </Text>
            )}
          </PressableScale>

          <PressableScale
            onPress={() => {
              haptic('Light');
              onSave();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={isSaved ? 'Remove from saved' : 'Save post'}
          >
            {isSaved ? (
              <BookmarkActive size={DETAIL_ICON_SIZE} color={theme.colors.primary} />
            ) : (
              <Bookmark size={DETAIL_ICON_SIZE} className="text-muted-foreground" />
            )}
          </PressableScale>

          <PressableScale
            onPress={() => {
              haptic('Light');
              onShare();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Share"
          >
            <ShareIcon size={DETAIL_ICON_SIZE} className="text-muted-foreground" />
          </PressableScale>

          {onInsightsPress && (
            <PressableScale
              onPress={() => {
                haptic('Light');
                onInsightsPress();
              }}
              hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel="Insights"
            >
              <AnalyticsIcon size={DETAIL_ICON_SIZE} className="text-muted-foreground" />
            </PressableScale>
          )}
        </View>

        {/* Bottom divider */}
        <View className="bg-border" style={{ height: StyleSheet.hairlineWidth }} />
      </View>
    );
  }

  // Build summary parts like Threads: "X replies · Y likes"
  const summaryParts: string[] = [];
  if (replies > 0) summaryParts.push(`${formatCompactNumber(replies)} ${replies === 1 ? 'reply' : 'replies'}`);

  return (
    <View>
      {/* Icon row -- icon-only, left-aligned */}
      <View className="flex-row items-center" style={{ gap: 12 }}>
        {voteStyle === 'pill' && onDownvote ? (
          <VotePill
            likeCount={likes}
            downvoteCount={downvotes}
            isLiked={!!isLiked}
            isDownvoted={!!isDownvoted}
            onUpvote={() => {
              hasBeenToggled.current = true;
              onLike();
            }}
            onDownvote={onDownvote}
          />
        ) : (
          <PressableScale
            style={styles.iconButton}
            onPress={() => {
              hasBeenToggled.current = true;
              haptic('Light');
              onLike();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
          >
            <View className="flex-row items-center gap-1">
              <AnimatedLikeIcon
                isLiked={!!isLiked}
                hasBeenToggled={hasBeenToggled.current}
              />
              <CountWheel
                likeCount={likes}
                isLiked={!!isLiked}
                hasBeenToggled={hasBeenToggled.current}
              />
            </View>
          </PressableScale>
        )}

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Light');
            onReply();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Reply"
        >
          <CommentIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Medium');
            onBoost();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={isBoosted ? 'Undo boost' : 'Boost'}
        >
          {isBoosted ? (
            <BoostIconActive size={ICON_SIZE} color={theme.colors.success} />
          ) : (
            <BoostIcon size={ICON_SIZE} className="text-muted-foreground" />
          )}
        </PressableScale>

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Light');
            onShare();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Share"
        >
          <ShareIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>

        {/* Spacer: pushes Save + Translate + Insights to the right edge */}
        <View className="flex-1" />

        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('Light');
            onSave();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={isSaved ? 'Remove from saved' : 'Save post'}
        >
          {isSaved ? (
            <BookmarkActive size={ICON_SIZE} color={theme.colors.primary} />
          ) : (
            <Bookmark size={ICON_SIZE} className="text-muted-foreground" />
          )}
        </PressableScale>

        {onTranslate && (
          <PressableScale
            style={styles.iconButton}
            onPress={() => {
              haptic('Light');
              onTranslate();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={isTranslated ? 'Show original' : 'Translate'}
            disabled={isTranslating}
          >
            {isTranslating ? (
              <SpinnerIcon size={16} className="text-muted-foreground" />
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons
                  name={isTranslated ? 'language' : 'language-outline'}
                  size={ICON_SIZE}
                  color={isTranslated ? theme.colors.primary : theme.colors.textSecondary}
                />
                {!isPremium && (
                  <Ionicons
                    name="lock-closed"
                    size={ICON_SIZE * 0.5}
                    color={theme.colors.textSecondary}
                    style={{ marginLeft: -4, marginTop: -6 }}
                  />
                )}
              </View>
            )}
          </PressableScale>
        )}

        {onInsightsPress && (
          <PressableScale
            style={styles.iconButton}
            onPress={() => {
              haptic('Light');
              onInsightsPress();
            }}
            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Insights"
          >
            <AnalyticsIcon size={ICON_SIZE} className="text-muted-foreground" />
          </PressableScale>
        )}
      </View>

      {/* Engagement summary -- avatar bubbles + "X replies . Y likes" */}
      {summaryParts.length > 0 && (
        <PressableScale
          className="flex-row items-center mt-2"
          style={{ gap: 6 }}
          onPress={likes > 0 ? (onLikesPress ?? undefined) : undefined}
          disabled={!onLikesPress && !onBoostsPress}
        >
          {replierAvatars.length > 0 && (
            <View className="flex-row items-center">
              {replierAvatars.slice(0, 3).map((avatarId, i) => (
                <View
                  key={i}
                  className="border-background"
                  style={[
                    styles.miniAvatarWrap,
                    i > 0 && { marginLeft: AVATAR_OVERLAP },
                    { zIndex: 3 - i },
                  ]}
                >
                  <Avatar source={avatarId} size={MINI_AVATAR} />
                </View>
              ))}
            </View>
          )}
          <Text className="text-muted-foreground text-[13px]">
            {summaryParts.join(' \u00B7 ')}
          </Text>
        </PressableScale>
      )}
    </View>
  );
};

// Mounted once per feed row. Memoized so an unrelated re-render of a sibling row
// (or the parent feed) does not re-render every action bar — effective because
// PostItem now hands it a stable `engagement` object and memoized callbacks.
export default React.memo(PostActions);

const styles = StyleSheet.create({
  iconButton: {
    padding: 2,
  },
  miniAvatarWrap: {
    borderWidth: 1.5,
    borderRadius: MINI_AVATAR / 2 + 1.5,
    overflow: 'hidden',
  },
});
