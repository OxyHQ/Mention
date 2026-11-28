import { View, StyleSheet } from 'react-native';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { Text } from '@oxy.so/bloom/typography';
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { cn } from '@/lib/utils';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const useTextStyles = createTokenStyles((t) => ({
  description: { fontSize: 14, lineHeight: 20, color: t.mutedForeground },
  descriptionSpaced: { marginTop: 4 },
  name: { fontSize: 16, lineHeight: 20, fontWeight: '600' },
  byline: { fontSize: 14, lineHeight: 18, color: t.mutedForeground },
  stat: { fontSize: 14, lineHeight: 24, color: t.mutedForeground, fontWeight: '600' },
}));

/** Card surface (default) vs. flush full-width list row (result lists). */
const useOuterStyles = createTokenStyles((t) => ({
  card: {
    width: '100%',
    padding: 16,
    gap: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.border,
    backgroundColor: t.card,
  },
  row: {
    width: '100%',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: 1,
    borderColor: t.border,
  },
}));

/**
 * ListCard Component
 *
 * A component for displaying user lists (e.g., moderation lists, curated lists).
 *
 * Two visual languages, picked with `variant`:
 * - `card` (default): a bordered, rounded surface — for standalone list grids.
 * - `row`: a flush, full-width feed row (bottom hairline, no radius) — for result
 *   lists that must share ONE visual language with the feed (search).
 */

export interface ListCardData {
  id: string;
  uri: string;
  name: string;
  description?: string;
  creator?: {
    username: string;
    displayName?: string;
    avatar?: string | null;
  };
  purpose?: 'curatelist' | 'modlist';
  itemCount?: number;
  subscriberCount?: number;
}

export type ListCardVariant = 'card' | 'row';

interface ListCardProps {
  list: ListCardData;
  onPress?: () => void;
  showPinButton?: boolean;
  variant?: ListCardVariant;
}

/**
 * Main ListCard component
 */
export function ListCard({
  list,
  onPress,
  showPinButton = false,
  variant = 'card',
}: ListCardProps) {
  const textStyles = useTextStyles();
  const outerStyles = useOuterStyles();
  const router = useRouter();
  const { t } = useTranslation();
  const isRow = variant === 'row';

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else if (list.id) {
      router.push(`/lists/${list.id}`);
    }
  };

  const purposeLabel = list.purpose === 'modlist' ? 'Moderation list' : 'List';

  return (
    <PressableScale onPress={handlePress} style={isRow ? outerStyles.row : outerStyles.card}>
      <View className="flex-row items-center gap-3">
        <Avatar size={40} variant={MEDIA_VARIANT_AVATAR} />
        <View className="flex-1 gap-1">
          <Text style={textStyles.name} numberOfLines={1}>
            {list.name}
          </Text>
          {list.creator && (
            <ProfileHoverCard username={getNormalizedUserHandle(list.creator) ?? undefined}>
              <Text style={textStyles.byline} numberOfLines={1}>
                {purposeLabel} by @{list.creator.username}
              </Text>
            </ProfileHoverCard>
          )}
        </View>
        {showPinButton && (
          <View className="items-end min-w-[80px]">
            {/* Pin button can be added here if needed */}
          </View>
        )}
      </View>
      {list.description && (
        <Text
          style={[textStyles.description, !isRow && textStyles.descriptionSpaced]}
          numberOfLines={isRow ? 2 : 3}
        >
          {list.description}
        </Text>
      )}
      {(list.itemCount !== undefined || list.subscriberCount !== undefined) && (
        <View className={cn('flex-row items-center gap-3', !isRow && 'mt-1')}>
          {list.itemCount !== undefined && (
            <Text style={textStyles.stat}>
              {list.itemCount} {list.itemCount === 1 ? 'item' : 'items'}
            </Text>
          )}
          {list.subscriberCount !== undefined && (
            <Text style={textStyles.stat}>
              {t('lists.subscriberCount', {
                count: list.subscriberCount,
                defaultValue: '{{count}} subscribers',
              })}
            </Text>
          )}
        </View>
      )}
    </PressableScale>
  );
}
