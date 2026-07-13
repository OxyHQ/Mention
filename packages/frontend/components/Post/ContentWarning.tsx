import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';

interface Props {
  /** The content-warning summary text carried on the post (e.g. Mastodon `summary`). */
  text: string;
}

/**
 * Small warning label rendered above a post's body. Federated posts (Mastodon and
 * friends) carry a content warning as `metadata.spoilerText`; when present we surface
 * it as a visible marker so CW posts — which frequently have an empty body — aren't
 * blank and the viewer sees the warning. Media blurring is handled separately by
 * `PostAttachmentsRow` via the `sensitive` prop; this label never gates the body.
 */
const ContentWarning: React.FC<Props> = ({ text }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const label = t('post.contentWarning', { defaultValue: 'Content warning' });

  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={`${label}: ${text}`}
      className="border-border bg-surface mb-1.5 flex-row items-center gap-1.5 self-start rounded-lg border px-2.5 py-1"
    >
      <Ionicons name="warning-outline" size={14} color={theme.colors.textSecondary} />
      <Text className="text-muted-foreground text-[13px] font-semibold flex-shrink" numberOfLines={3}>
        <Text className="text-muted-foreground">{label}</Text>
        {text ? ` · ${text}` : ''}
      </Text>
    </View>
  );
};

export default React.memo(ContentWarning);
