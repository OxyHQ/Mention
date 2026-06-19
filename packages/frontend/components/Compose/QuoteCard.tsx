import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';

import { CloseIcon } from '@/assets/icons/close-icon';

interface QuoteCardProps {
  /** The fetched quoted post; null while loading or if not found. */
  post: HydratedPost | HydratedPostSummary | null;
  /** Whether the underlying fetch is in flight. */
  loading: boolean;
  /** Called when the user taps the close button. */
  onDismiss: () => void;
}

/**
 * Compact preview for a quoted post inside the composer.
 *
 * Mirrors the visual treatment of the parent-post preview in the reply flow
 * (compose.tsx:1203-1214) but renders an inline, dismissible card so the
 * composer stays light. Falls back to a skeleton while loading.
 *
 * When the host hook (`useQuoteManager`) hits a 404 / private / network error,
 * it sets `fallbackUrl` and the composer appends that URL to the text instead
 * of rendering this card — so an "unknown post" state isn't represented here.
 */
const QuoteCard: React.FC<QuoteCardProps> = ({ post, loading, onDismiss }) => {
  const { t } = useTranslation();

  const previewText = useMemo(() => {
    if (!post) return '';
    const text = post.content?.text;
    if (typeof text === 'string') return text;
    return '';
  }, [post]);

  const userName = useMemo(() => {
    if (!post) return '';
    return post.user ? post.user.displayName : '';
  }, [post]);

  const userHandle = useMemo(() => {
    if (!post) return '';
    const handle = post.user?.handle;
    if (!handle) return '';
    return handle.startsWith('@') ? handle.slice(1) : handle;
  }, [post]);

  const avatarUri = useMemo(() => {
    if (!post) return undefined;
    const raw = post.user?.avatarUrl || post.user?.avatar;
    if (!raw) return undefined;
    return typeof raw === 'string' && raw.startsWith('http') ? raw : undefined;
  }, [post]);

  if (loading) {
    return (
      <View
        className="border-border bg-secondary rounded-2xl border px-4 py-3"
        accessibilityRole="progressbar"
        accessibilityLabel={t('compose.quote.loading', { defaultValue: 'Loading quoted post' })}
      >
        <View className="flex-row items-center">
          <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
          <Text className="text-muted-foreground ml-2 text-[13px]">
            {t('compose.quote.loading', { defaultValue: 'Loading quoted post...' })}
          </Text>
        </View>
      </View>
    );
  }

  if (!post) return null;

  return (
    <View className="border-border bg-secondary relative rounded-2xl border px-4 py-3">
      <View className="flex-row items-start">
        <Avatar source={avatarUri} size={28} style={{ marginRight: 10 }} />
        <View className="flex-1 pr-6">
          <View className="flex-row items-center">
            {userName ? (
              <Text className="text-foreground text-[14px] font-semibold" numberOfLines={1}>
                {userName}
              </Text>
            ) : null}
            {userHandle ? (
              <Text className="text-muted-foreground ml-1 text-[13px]" numberOfLines={1}>
                @{userHandle}
              </Text>
            ) : null}
          </View>
          {previewText ? (
            <Text className="text-foreground mt-1 text-[14px]" numberOfLines={3}>
              {previewText}
            </Text>
          ) : null}
        </View>
      </View>
      <TouchableOpacity
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t('compose.quote.dismiss', { defaultValue: 'Remove quoted post' })}
        className="bg-background absolute right-2 top-2 rounded-full p-1.5"
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <CloseIcon size={14} className="text-foreground" />
      </TouchableOpacity>
    </View>
  );
};

QuoteCard.displayName = 'QuoteCard';

export default React.memo(QuoteCard);
