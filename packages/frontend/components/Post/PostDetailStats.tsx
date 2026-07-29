import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { formatCompactNumber } from '@/utils/formatNumber';
import { POST_ITEM_SPACING } from '@/styles/shared';

const { HPAD, SECTION_GAP } = POST_ITEM_SPACING;

interface Props {
  /** Full absolute timestamp, e.g. "9:20 PM · Jun 11, 2026". */
  timestampLabel: string;
  likes: number;
  boosts: number;
  /**
   * Quotes are counted on read, so only the post-detail endpoints return them
   * (`includeQuoteCounts`). Absent on a feed-seeded cache paint until the detail
   * read lands — the entry simply does not appear until then.
   */
  quotes: number;
  saves: number;
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

  // Zero counts are dropped, so a post nobody has touched shows the timestamp
  // alone rather than a row of zeroes.
  const statsEntries: { key: string; label: string; count: number; onPress?: () => void }[] = [];
  if (likes > 0) statsEntries.push({ key: 'likes', label: t('post.stats.likes', { count: likes }), count: likes, onPress: onLikesPress });
  if (boosts > 0) statsEntries.push({ key: 'boosts', label: t('post.stats.boosts', { count: boosts }), count: boosts, onPress: onBoostsPress });
  if (quotes > 0) statsEntries.push({ key: 'quotes', label: t('post.stats.quotes', { count: quotes }), count: quotes });
  if (saves > 0) statsEntries.push({ key: 'saves', label: t('post.stats.saves', { count: saves }), count: saves });

  if (!timestampLabel && statsEntries.length === 0) return null;

  return (
    <View
      className="border-border"
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: HPAD,
        paddingTop: SECTION_GAP,
        gap: SECTION_GAP,
      }}
    >
      {timestampLabel ? (
        <View className="flex-row items-center">
          <Text className="text-muted-foreground text-[14px]">{timestampLabel}</Text>
          <Ionicons name="globe-outline" size={14} color={theme.colors.textSecondary} style={{ marginLeft: 6 }} />
        </View>
      ) : null}

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
    </View>
  );
});

export default PostDetailStats;
