import { tokens } from '@oxy.so/bloom/styles';
import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useMemo } from 'react';
import { TouchableOpacity } from 'react-native';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { useTranslation } from 'react-i18next';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { getNormalizedUserHandle } from '@oxy.so/core';

import { createTokenStyles } from '@oxy.so/bloom/theme';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

import {
  Card as LCard,
  Embed,
  HStack,
  Icon,
  RawText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/** The dismiss button's inset from its edge, in points (Tailwind's `p-1.5`). */
const CLOSE_PADDING = 6;
/** Tailwind's `rounded-full` as it drew: a pill at any size. */
const ROUNDED_FULL = Number.MAX_SAFE_INTEGER;

const useCloseStyles = createTokenStyles((t) => ({
  close: {
    position: 'absolute',
    right: tokens.space.sm,
    top: tokens.space.sm,
    padding: CLOSE_PADDING,
    borderRadius: ROUNDED_FULL,
    backgroundColor: t.background,
  },
}));

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
  const closeStyles = useCloseStyles();
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
    return toElement(
      LCard(Embed(<FeedSkeleton count={1} />))
        .style('subtle')
        .outline('thin')
        .radius('lg')
        .padding('horizontal', 'lg')
        .padding('vertical', 'md'),
    );
  }

  if (!post) return null;

  return toElement(
    LCard(
      HStack(
        // `avatar` is a bare Oxy file id OR an absolute URL, for local and
        // federated authors alike — Bloom's Avatar accepts both shapes (and
        // `null`) directly and ignores `variant` for an absolute URL, so
        // nothing needs branching or coercing here.
        Embed(
          <AccountAvatar
            account={post.user}
            source={post?.user?.avatar}
            variant={MEDIA_VARIANT_AVATAR}
            size={28}
            style={{ marginRight: 10 }}
          />,
        ),
        VStack(
          HStack(
            userName
              ? RawText(userName).foreground('foreground').font('14').weight('semibold').lines(1)
              : null,
            userHandle
              ? RawText('@', userHandle)
                  .foreground('muted')
                  .margin('left', 'xs')
                  .font('sm')
                  .lines(1)
              : null,
          ).align('center'),
          previewText
            ? RawText(previewText).foreground('foreground').margin('top', 'xs').font('14').lines(3)
            : null,
        )
          .padding('right', '2xl')
          .flex('1'),
      ).align('start'),
      Embed(
        <TouchableOpacity
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={t('compose.quote.dismiss', { defaultValue: 'Remove quoted post' })}
          style={closeStyles.close}
          hitSlop={tokens.hitSlop.sm}
        >
          {toElement(Icon(RiCloseLine).size('14').foreground('foreground'))}
        </TouchableOpacity>,
      ),
    )
      .style('subtle')
      .outline('thin')
      .radius('lg')
      .padding('horizontal', 'lg')
      .padding('vertical', 'md'),
  );
};

QuoteCard.displayName = 'QuoteCard';

export default React.memo(QuoteCard);
