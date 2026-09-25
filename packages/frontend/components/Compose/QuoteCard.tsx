import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Card } from '@oxy.so/bloom/card';
import { Loading } from '@oxy.so/bloom/loading';
import { useTranslation } from 'react-i18next';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { getNormalizedUserHandle } from '@oxy.so/core';

import { CloseIcon } from '@/assets/icons/close-icon';
import { HIT_SLOP_SM } from '@/styles/hitSlop';

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

  const userName = useMemo(() => post?.user?.name?.displayName ?? '', [post]);

  const userHandle = useMemo(() => getNormalizedUserHandle(post?.user) ?? '', [post]);

  if (loading) {
    return (
      <Card appearance="subtle" border="thin" radius="radius-16" className="px-4 py-3">
        <View
          className="flex-row items-center"
          accessibilityRole="progressbar"
          accessibilityLabel={t('compose.quote.loading', { defaultValue: 'Loading quoted post' })}
        >
          <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
          <Text className="text-muted-foreground ml-2 text-[13px]">
            {t('compose.quote.loading', { defaultValue: 'Loading quoted post...' })}
          </Text>
        </View>
      </Card>
    );
  }

  if (!post) return null;

  return (
    <Card appearance="subtle" border="thin" radius="radius-16" className="relative px-4 py-3">
      <View className="flex-row items-start">
        {/* `avatar` is a bare Oxy file id OR an absolute URL, for local and
            federated authors alike — Bloom's Avatar accepts both shapes
            (and `null`) directly and ignores `variant` for an absolute URL,
            so nothing needs branching or coercing here. */}
        <Avatar source={post?.user?.avatar} variant={MEDIA_VARIANT_AVATAR} size={28} style={{ marginRight: 10 }} />
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
        hitSlop={HIT_SLOP_SM}
      >
        <CloseIcon size={14} className="text-foreground" />
      </TouchableOpacity>
    </Card>
  );
};

QuoteCard.displayName = 'QuoteCard';

export default React.memo(QuoteCard);
