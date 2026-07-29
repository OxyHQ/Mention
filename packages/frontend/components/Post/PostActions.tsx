import React, { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import Ionicons from '@expo/vector-icons/Ionicons';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { BoostIcon, BoostIconActive } from '@/assets/icons/boost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@oxyhq/bloom/hooks';
import { formatCompactNumber } from '@/utils/formatNumber';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { AnimatedLikeIcon } from '@/lib/animations/AnimatedLikeIcon';
import { CountWheel } from '@/lib/animations/CountWheel';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import { POST_ITEM_SPACING } from '@/styles/shared';
import VotePill from './VotePill';

const ICON_SIZE = 20;
/** Same vertical rhythm PostItem puts between a post's own blocks. */
const { SECTION_GAP } = POST_ITEM_SPACING;
const MINI_AVATAR = 16;
const AVATAR_OVERLAP = -4;

interface Engagement {
  replies: number | null;
  boosts: number | null;
  likes: number | null;
  downvotes?: number | null;
  saves?: number | null;
  views?: number | null;
  /** Only the post-detail read carries this — see `includeQuoteCounts` on the backend. */
  quotes?: number | null;
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
  postId?: string;
  /**
   * Focused post-detail variant. Renders the SAME icon row as a feed row, with
   * two extra rows stacked above it: the full absolute timestamp and a tappable
   * engagement-stats summary. Nothing about the buttons themselves changes.
   */
  detail?: boolean;
  /** Full absolute timestamp (detail variant only), e.g. "9:20 PM · Jun 11, 2026". */
  timestampLabel?: string;
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
  detail = false,
  timestampLabel,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  const hasBeenToggled = useRef(false);
  const voteStyle = useVoteStyle();
  const { t } = useTranslation();

  const replies = engagement?.replies ?? 0;
  const likes = engagement?.likes ?? 0;
  const boosts = engagement?.boosts ?? 0;
  const saves = engagement?.saves ?? 0;
  const quotes = engagement?.quotes ?? 0;
  const downvotes = engagement?.downvotes ?? 0;
  const replierAvatars = engagement?.recentReplierAvatars ?? [];

  // The action bar itself — identical on a feed row and on the post-detail
  // screen. The detail variant only stacks extra rows ABOVE it (timestamp,
  // engagement stats); it must never fork the buttons themselves, or the two
  // surfaces drift in icon size, order and affordances.
  const actionIconRow = (
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
            haptic('light');
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
          haptic('light');
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
          haptic('medium');
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
          haptic('light');
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
        className="flex-row items-center"
        style={[styles.iconButton, { gap: 6 }]}
        onPress={() => {
          haptic('light');
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
        {saves > 0 && (
          <Text
            className={isSaved ? 'text-[13px]' : 'text-[13px] text-muted-foreground'}
            style={isSaved ? { color: theme.colors.primary } : undefined}
          >
            {formatCompactNumber(saves)}
          </Text>
        )}
      </PressableScale>

      {onTranslate && (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('light');
            onTranslate();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={isTranslated ? 'Show original' : 'Translate'}
          disabled={isTranslating}
        >
          {isTranslating ? (
            <SpinnerIcon size={16} className="text-muted-foreground" />
          ) : (
            <Ionicons
              name={isTranslated ? 'language' : 'language-outline'}
              size={ICON_SIZE}
              color={isTranslated ? theme.colors.primary : theme.colors.textSecondary}
            />
          )}
        </PressableScale>
      )}

      {onInsightsPress && (
        <PressableScale
          style={styles.iconButton}
          onPress={() => {
            haptic('light');
            onInsightsPress();
          }}
          hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Insights"
        >
          <AnalyticsIcon size={ICON_SIZE} className="text-muted-foreground" />
        </PressableScale>
      )}
    </View>
  );

  if (detail) {
    // Engagement-stats summary, the ONE thing the detail variant adds over the
    // feed row: the counts the icon row deliberately does not carry. Entries with
    // a zero count are dropped, and a `quotes` count only exists when the caller
    // asked the backend for it (`includeQuoteCounts`) — feed-seeded cache paints
    // without it until the detail read lands.
    const statsEntries: { key: string; label: string; count: number; onPress?: () => void }[] = [];
    if (likes > 0) statsEntries.push({ key: 'likes', label: t('post.stats.likes', { count: likes }), count: likes, onPress: onLikesPress });
    if (boosts > 0) statsEntries.push({ key: 'boosts', label: t('post.stats.boosts', { count: boosts }), count: boosts, onPress: onBoostsPress });
    if (quotes > 0) statsEntries.push({ key: 'quotes', label: t('post.stats.quotes', { count: quotes }), count: quotes });
    if (saves > 0) statsEntries.push({ key: 'saves', label: t('post.stats.saves', { count: saves }), count: saves });

    // Rows only — NO dividers. PostItem mounts this inside the content column
    // (`paddingLeft: AVATAR_OFFSET`), so any hairline drawn here starts 64px in
    // and stops short of the right edge: a stub that reads as a broken separator
    // beside the container's own full-width bottom border. Row separation is
    // spacing, and closing the post is the container's job — exactly as in a feed
    // row. `SECTION_GAP` is the same rhythm PostItem uses between its own blocks.
    return (
      <View style={{ gap: SECTION_GAP }}>
        {/* Full absolute timestamp */}
        {timestampLabel ? (
          <View className="flex-row items-center">
            <Text className="text-muted-foreground text-[14px]">{timestampLabel}</Text>
            <Ionicons name="globe-outline" size={14} color={theme.colors.textSecondary} style={{ marginLeft: 6 }} />
          </View>
        ) : null}

        {/* Engagement stats */}
        {statsEntries.length > 0 && (
          <View className="flex-row items-center flex-wrap" style={{ gap: 16 }}>
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

        {/* The SAME icon row the feed renders — the detail screen differs from a
            feed row only by what it adds ABOVE this bar, never by rebuilding it
            or fencing it in. */}
        {actionIconRow}
      </View>
    );
  }

  // Build summary parts like Threads: "X replies · Y likes"
  const summaryParts: string[] = [];
  if (replies > 0) summaryParts.push(`${formatCompactNumber(replies)} ${replies === 1 ? 'reply' : 'replies'}`);

  return (
    <View>
      {actionIconRow}

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
                  <Avatar source={avatarId} size={MINI_AVATAR} variant={MEDIA_VARIANT_AVATAR} />
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
