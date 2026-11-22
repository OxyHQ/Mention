import { View, StyleSheet } from 'react-native';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { Text } from '@oxy.so/bloom/typography';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { cn } from '@/lib/utils';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import {
  Avatar as LAvatar,
  Embed,
  HStack,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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

type ListCardVariant = 'card' | 'row';

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
    <PressableScale
      onPress={handlePress}
      className={cn(
        'w-full',
        isRow
          ? 'px-3 py-3 gap-1 border-b border-border'
          : 'bg-card border-border p-4 rounded-xl gap-3',
      )}
      style={isRow ? undefined : { borderWidth: StyleSheet.hairlineWidth }}
    >
      {toElement(
        HStack(
          LAvatar(undefined, { variant: MEDIA_VARIANT_AVATAR }).size('xl'),
          VStack(
            LText(list.name)
              .font('16')
              .weight('semibold')
              .leading('20px')
              .foreground('foreground')
              .lines(1),
            Embed(
              list.creator && (
                <ProfileHoverCard username={getNormalizedUserHandle(list.creator) ?? undefined}>
                  {toElement(
                    LText(purposeLabel, ' by @', list.creator.username)
                      .foreground('muted')
                      .font('14')
                      .leading('18px')
                      .lines(1),
                  )}
                </ProfileHoverCard>
              ),
            ),
          )
            .flex('1')
            .spacing('xs'),
          Embed(
            showPinButton &&
              toElement(
                VStack(/* Pin button can be added here if needed */)
                  .frame({ minWidth: '80' })
                  .align('end'),
              ),
          ),
        )
          .align('center')
          .spacing('md'),
      )}
      {list.description && (
        <Text
          className={cn('text-muted-foreground text-sm leading-5', !isRow && 'mt-1')}
          numberOfLines={isRow ? 2 : 3}
        >
          {list.description}
        </Text>
      )}
      {(list.itemCount !== undefined || list.subscriberCount !== undefined) && (
        <View className={cn('flex-row items-center gap-3', !isRow && 'mt-1')}>
          {list.itemCount !== undefined &&
            toElement(
              LText(list.itemCount, ' ', list.itemCount === 1 ? 'item' : 'items')
                .foreground('muted')
                .font('14')
                .leading('24px')
                .weight('semibold'),
            )}
          {list.subscriberCount !== undefined &&
            toElement(
              LText(
                t('lists.subscriberCount', {
                  count: list.subscriberCount,
                  defaultValue: '{{count}} subscribers',
                }),
              )
                .foreground('muted')
                .font('14')
                .leading('24px')
                .weight('semibold'),
            )}
        </View>
      )}
    </PressableScale>
  );
}
