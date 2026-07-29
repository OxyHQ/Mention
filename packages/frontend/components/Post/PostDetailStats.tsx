import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { formatCompactNumber } from '@/utils/formatNumber';
import { POST_ITEM_SPACING } from '@/styles/shared';

const { HPAD, SECTION_GAP } = POST_ITEM_SPACING;

/**
 * A count straight off the post DTO, NOT coalesced by the caller — the three
 * states have to stay distinguishable here:
 *   number    → render it, zero included;
 *   null      → the author hides this counter (`hideLikeCounts` and friends), so
 *               the entry is omitted rather than shown as a misleading "0";
 *   undefined → this DTO never carried the field (only quotes, which the feed
 *               does not count) — read as 0 until the detail response lands.
 */
type StatCount = number | null | undefined;

interface Props {
  /** Full absolute timestamp, e.g. "9:20 PM · Jun 11, 2026". */
  timestampLabel: string;
  likes: StatCount;
  boosts: StatCount;
  quotes: StatCount;
  saves: StatCount;
  onLikesPress?: () => void;
  onBoostsPress?: () => void;
}

/**
 * The block a FOCUSED post carries under its action bar: the absolute timestamp
 * and the engagement counts a feed row does not show. Everything above it — the
 * header, the body, the attachments, the action bar — is the plain feed
 * rendering, unchanged; this is the whole of what "post detail" adds.
 *
 * PostItem mounts it OUTSIDE the avatar-indented content column on purpose. A
 * hairline drawn inside that column starts `AVATAR_OFFSET` (64px) from the left
 * and stops short of the right edge, reading as a broken stub next to the
 * container's own full-width bottom border; out here the rule spans the row
 * exactly like that border does.
 */
const PostDetailStats = memo<Props>(function PostDetailStats({
  timestampLabel,
  likes,
  boosts,
  quotes,
  saves,
  onLikesPress,
  onBoostsPress,
}) {
  const theme = useTheme();
  const { t } = useTranslation();

  // Every counter the author publishes is listed, zeroes included — a fresh post
  // reads "0 likes · 0 boosts …" rather than silently dropping rows as the counts
  // move, which made the block change height on every like.
  const statsEntries: { key: string; label: string; count: number; onPress?: () => void }[] = [];
  const pushStat = (key: string, count: StatCount, onPress?: () => void) => {
    if (count === null) return; // author hides this counter
    const value = count ?? 0;
    statsEntries.push({ key, label: t(`post.stats.${key}`, { count: value }), count: value, onPress });
  };
  pushStat('likes', likes, onLikesPress);
  pushStat('boosts', boosts, onBoostsPress);
  pushStat('quotes', quotes);
  pushStat('saves', saves);

  if (!timestampLabel && statsEntries.length === 0) return null;

  // Each row carries its OWN full-width top rule. The wrapper deliberately holds
  // no horizontal padding so those rules span the row exactly like the post
  // container's bottom border; the padding lives on the rows themselves.
  const rowStyle = {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: HPAD,
    paddingTop: SECTION_GAP,
  } as const;

  return (
    <View>
      {timestampLabel ? (
        <View className="flex-row items-center border-border" style={[rowStyle, { paddingBottom: SECTION_GAP }]}>
          <Text className="text-muted-foreground text-[14px]">{timestampLabel}</Text>
          <Ionicons name="globe-outline" size={14} color={theme.colors.textSecondary} style={{ marginLeft: 6 }} />
        </View>
      ) : null}

      {statsEntries.length > 0 && (
        // No bottom padding: the post container's own `VPAD` closes the block.
        <View className="flex-row items-center flex-wrap border-border" style={[rowStyle, { gap: 16 }]}>
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
    </View>
  );
});

export default PostDetailStats;
