import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useMemo } from 'react';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { useTranslation } from 'react-i18next';
import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { getNormalizedUserHandle } from '@oxy.so/core';

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
      VStack(Icon(RiCloseLine).size('14').foreground('foreground'))
        .padding('6')
        .background('background')
        .corner('infinite')
        .position({ right: 'sm', top: 'sm' })
        .onPress(onDismiss)
        .hitSlop('sm')
        .role('button')
        .label(t('compose.quote.dismiss', { defaultValue: 'Remove quoted post' }))
        .pressFade(),
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
