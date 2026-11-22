import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
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

  return toElement(
    VStack(
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
        showPinButton
          ? VStack(/* Pin button can be added here if needed */)
              .frame({ minWidth: '80' })
              .align('end')
          : null,
      )
        .align('center')
        .spacing('md'),
      list.description
        ? LText(list.description)
            .foreground('muted')
            .font('14')
            .leading('20px')
            .lines(isRow ? 2 : 3)
            .when(!isRow, (v) => v.margin('top', 'xs'))
        : null,
      list.itemCount !== undefined || list.subscriberCount !== undefined
        ? HStack(
            list.itemCount !== undefined
              ? LText(list.itemCount, ' ', list.itemCount === 1 ? 'item' : 'items')
                  .foreground('muted')
                  .font('14')
                  .leading('24px')
                  .weight('semibold')
              : null,
            list.subscriberCount !== undefined
              ? LText(
                  t('lists.subscriberCount', {
                    count: list.subscriberCount,
                    defaultValue: '{{count}} subscribers',
                  }),
                )
                  .foreground('muted')
                  .font('14')
                  .leading('24px')
                  .weight('semibold')
              : null,
          )
            .align('center')
            .spacing('md')
            .when(!isRow, (v) => v.margin('top', 'xs'))
        : null,
    )
      .padding(isRow ? 'md' : 'lg')
      .frame({ width: 'full' })
      .spacing(isRow ? 'xs' : 'md')
      // A row is a flush feed row; a card a bordered, rounded surface.
      .when(isRow, (v) => v.border('border', 'thin', 'bottom'))
      .when(!isRow, (v) => v.background('card').border('border', 'hairline').corner('md'))
      .pressScale()
      .onPress(handlePress),
  );
}
