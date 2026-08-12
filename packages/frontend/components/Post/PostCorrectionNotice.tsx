import React, { useCallback } from 'react';
import { GestureResponderEvent, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

const NOTICE_ICON_SIZE = 13;

interface Props {
  /** The post this trail belongs to — the row leads to its history screen. */
  postId: string;
  /** Corrections MADE, from `metadata.corrections.count`. */
  count: number;
}

/**
 * "Corrected 3 times · View history".
 *
 * A quiet line under the body — now the only one there, since the language
 * switcher that used to share this slot was retired for an action-bar icon. It
 * is deliberately NOT a `ContentWarning`-style pill and NOT one of `PostItem`'s
 * context rows:
 *
 * - A context row (Reposted by / Pinned / Replying to) renders above the author's
 *   name and says why this row is in front of the reader. A correction says
 *   something about the BODY, so reading it before knowing whose post it is has
 *   the order backwards — and a fourth row there would shift the avatar and the
 *   thread line (`headerTopOffset`) on every corrected post.
 * - `ContentWarning`'s bordered pill sits above the body because a warning is a
 *   gate you read BEFORE the content. A correction notice is a footnote, not a
 *   warning, so it belongs after the text and at the volume of the language chip.
 *
 * It states the count and nothing else. When each correction happened is on the
 * history screen, where every version carries its own date — repeating the most
 * recent one here would make a feed row carry a second timestamp beside the
 * post's own, for a fact the reader is one tap from seeing in full.
 *
 * The whole row is the tap target rather than just the trailing label: there is
 * nothing else on the line, and a correction trail is worth more than a
 * word-sized target on a phone.
 */
const PostCorrectionNotice: React.FC<Props> = ({ postId, count }) => {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();

  const openHistory = useCallback(
    (event: GestureResponderEvent) => {
      // The row lives inside the post's own press target: opening the history
      // must never open the post detail underneath it.
      event.stopPropagation?.();
      router.push(`/p/${postId}/corrections`);
    },
    [router, postId],
  );

  const countLabel = t('post.corrections.marker', {
    count,
    defaultValue: 'Corrected {{count}} times',
  });
  const actionLabel = t('post.corrections.viewHistory', { defaultValue: 'View history' });

  return (
    <Pressable
      onPress={openHistory}
      hitSlop={HIT_SLOP_MD}
      accessibilityRole="link"
      accessibilityLabel={`${countLabel}. ${actionLabel}`}
    >
      <View className="mt-1.5 flex-row items-center gap-1">
        <Ionicons name="create-outline" size={NOTICE_ICON_SIZE} color={theme.colors.textSecondary} />
        <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
          {countLabel}
        </Text>
        <Text className="text-muted-foreground text-[13px]">{'·'}</Text>
        <Text className="text-primary text-[13px] font-semibold" numberOfLines={1}>
          {actionLabel}
        </Text>
      </View>
    </Pressable>
  );
};

export default React.memo(PostCorrectionNotice);
