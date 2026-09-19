import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { useTranslation } from 'react-i18next';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

interface Props {
  /** The content-warning summary carried on the post (e.g. Mastodon `summary`). */
  text: string;
  /** Whether the reader has chosen to see what the warning covers. */
  revealed: boolean;
  onToggle: () => void;
}

/**
 * A post's content warning, as a GATE rather than a label.
 *
 * Federated posts (Mastodon and friends) carry a content warning as
 * `metadata.spoilerText`. The warning exists so a reader decides BEFORE seeing
 * the post, so while it is closed the post shows this block instead of its body
 * and every block below it (media, links, the quoted post) — `PostItem` owns
 * that and passes `revealed`. Once opened it shrinks to one line that can close
 * it again.
 *
 * It is the author's warning, not a moderation or community verdict, and says
 * so only through its label: it is styled as part of the post, never as a
 * system notice.
 */
const ContentWarning: React.FC<Props> = ({ text, revealed, onToggle }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const label = t('post.contentWarning', { defaultValue: 'Content warning' });
  const show = t('post.contentWarningShow', { defaultValue: 'Show' });
  const hide = t('post.contentWarningHide', { defaultValue: 'Hide' });

  if (revealed) {
    return (
      <View className="mb-1.5 flex-row items-center gap-1.5">
        <RiAlertLine width={13} height={13} fill={theme.colors.textSecondary} />
        <Text className="text-muted-foreground flex-shrink text-[13px]" numberOfLines={1}>
          {text ? `${label} · ${text}` : label}
        </Text>
        <Pressable onPress={onToggle} hitSlop={HIT_SLOP_MD} accessibilityRole="button" accessibilityLabel={hide}>
          <Text className="text-primary text-[13px] font-semibold">{hide}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={text ? `${label}: ${text}. ${show}` : `${label}. ${show}`}
      className="border-border bg-muted mt-0.5 flex-row items-center gap-3 rounded-2xl border px-3 py-3 active:opacity-80"
    >
      <View className="bg-background size-9 items-center justify-center rounded-full">
        <RiAlertLine width={18} height={18} fill={theme.colors.textSecondary} />
      </View>
      <View className="flex-1 shrink gap-0.5">
        <Text className="text-muted-foreground text-[12px] font-semibold uppercase tracking-wide">{label}</Text>
        {text ? (
          <Text className="text-foreground text-[15px] font-semibold" numberOfLines={3}>
            {text}
          </Text>
        ) : null}
      </View>
      <View className="bg-primary rounded-full px-3.5 py-1.5">
        <Text className="text-primary-foreground text-[13px] font-semibold">{show}</Text>
      </View>
    </Pressable>
  );
};

export default React.memo(ContentWarning);
