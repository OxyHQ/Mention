import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxyhq/core';

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

  const userName = useMemo(() => post?.user?.name?.displayName ?? '', [post]);

  const userHandle = useMemo(() => getNormalizedUserHandle(post?.user) ?? '', [post]);

  // Federation-aware avatar source for Bloom's Avatar (via the app-wide
  // ImageResolver): a FEDERATED/remote actor carries an absolute http(s) URL
  // (rendered directly; variant ignored); a LOCAL actor carries an Oxy file id
  // (resolved with `variant={MEDIA_VARIANT_AVATAR}` — the 128px crop). Bloom
  // disambiguates URL vs file id, so we pass the raw value through and only steer
  // the variant.
  const avatar = useMemo(() => {
    const raw = post?.user?.avatar;
    if (typeof raw !== 'string' || !raw) return { source: undefined, variant: undefined };
    const isRemote =
      post?.user?.isFederated === true || raw.startsWith('http://') || raw.startsWith('https://');
    return { source: raw, variant: isRemote ? undefined : MEDIA_VARIANT_AVATAR };
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
        <Avatar source={avatar.source} variant={avatar.variant} size={28} style={{ marginRight: 10 }} />
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
