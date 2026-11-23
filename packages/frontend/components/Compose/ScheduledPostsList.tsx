import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { RiListCheck3 } from '@oxy.so/bloom/icons/RiListCheck3';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { HydratedPost } from '@mention/shared-types';
import { isPastDue, scheduledDate } from '@/utils/postSchedule';
import { confirmDialog } from '@/utils/alerts';
import { formatScheduledLabel } from '@/utils/dateUtils';
import { createLogger } from '@oxy.so/core/logger';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Button as LButton,
  Embed,
  HStack,
  Icon,
  Loading,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const logger = createLogger('ScheduledPostsList');

interface ScheduledPostsListProps {
  posts: HydratedPost[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /**
   * The signed-in reader, so a row can say whose queue it is in.
   *
   * This list is no longer only the reader's own: `GET /posts/scheduled` returns
   * the shared editorial queue of every CHANNEL they operate, so that two people
   * publishing under one byline can see each other's plans instead of both
   * booking Tuesday. Every entry names its authoring account (`post.user`, which
   * IS the channel — a channel authors its own posts), and the id is what tells
   * "mine" from "the channel's".
   *
   * Optional because the sheet can render for a split second before the session
   * lands; an absent viewer labels nothing rather than labelling everything.
   */
  viewerId?: string;
  /** Open the full preview for one post. */
  onPreview: (post: HydratedPost) => void;
  /** Load one post back into the composer to rewrite or reschedule it. */
  onEdit: (post: HydratedPost) => void;
  /** Cancel one scheduled post. Rejects when the server refuses. */
  onCancel: (postId: string) => Promise<void>;
}

/**
 * Ask before deleting a scheduled post, then delete it.
 *
 * Shared with the preview so the two surfaces can never disagree about what the
 * user was told — including the past-due case, where the honest wording is that
 * the post may already have gone out (the publisher sweeps every 60s) and is
 * being deleted either way.
 */
export async function confirmAndCancel(params: {
  post: HydratedPost;
  onCancel: (postId: string) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}): Promise<boolean> {
  const { post, onCancel, t } = params;
  const pastDue = isPastDue(post);

  const confirmed = await confirmDialog({
    title: t('compose.scheduled.cancelTitle', { defaultValue: 'Cancel scheduled post' }),
    message: pastDue
      ? t('compose.scheduled.cancelConfirmPastDue', {
          defaultValue:
            'Its time has passed, so it may already have been published. Either way this post will be deleted.',
        })
      : t('compose.scheduled.cancelConfirm', {
          defaultValue: 'This post will be deleted and never published.',
        }),
    okText: t('compose.scheduled.cancelConfirmAction', { defaultValue: 'Cancel post' }),
    cancelText: t('common.cancel'),
    destructive: true,
  });

  if (!confirmed) {
    return false;
  }

  try {
    await onCancel(post.id);
    toast(t('compose.scheduled.cancelled', { defaultValue: 'Scheduled post cancelled' }), {
      type: 'success',
    });
    return true;
  } catch (error) {
    logger.error('Error cancelling scheduled post', error);
    toast(
      t('compose.scheduled.cancelError', { defaultValue: 'Failed to cancel the scheduled post' }),
      { type: 'error' },
    );
    return false;
  }
}

/**
 * The viewer's SERVER-side scheduled posts.
 *
 * The counterpart to `DraftsList`: both hold something unpublished, but a draft
 * only ever exists on this device while a scheduled post is already on the
 * server waiting for its publish time — which is why cancelling one is a network
 * write, and why previewing one is worth doing: this is the last look before it
 * goes out on its own.
 */
const ScheduledPostsList: React.FC<ScheduledPostsListProps> = ({
  posts,
  isLoading,
  isError,
  onRetry,
  onPreview,
  onEdit,
  onCancel,
  viewerId,
}) => {
  const { t } = useTranslation();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = useCallback(
    async (post: HydratedPost) => {
      setCancellingId(post.id);
      try {
        await confirmAndCancel({ post, onCancel, t });
      } finally {
        setCancellingId(null);
      }
    },
    [onCancel, t],
  );

  const getPreview = useCallback(
    (post: HydratedPost) => {
      const text = post.content?.text?.trim();
      if (text) {
        return text.length > 100 ? `${text.substring(0, 100)}...` : text;
      }
      const articleTitle = post.content?.article?.title?.trim();
      if (articleTitle) {
        return articleTitle;
      }
      const mediaCount = post.content?.media?.length ?? 0;
      if (mediaCount > 0) {
        return t('compose.draftWithMedia', { count: mediaCount });
      }
      if (post.content?.poll ?? post.content?.pollId) {
        return t('compose.draftWithPoll');
      }
      return t('compose.emptyDraft');
    },
    [t],
  );

  const renderItem = useCallback(
    ({ item }: { item: HydratedPost }) => {
      const isCancelling = cancellingId === item.id;
      const publishAt = scheduledDate(item);
      const mediaCount = item.content?.media?.length ?? 0;
      const hasPoll = Boolean(item.content?.poll ?? item.content?.pollId);

      // A past-due row must not keep advertising a future time: by then the 60s
      // publisher sweep may already have sent it.
      const timeLabel =
        publishAt === null
          ? t('compose.scheduled.unknownTime', { defaultValue: 'Time unavailable' })
          : isPastDue(item)
            ? t('compose.scheduled.publishing', { defaultValue: 'Publishing now…' })
            : formatScheduledLabel(publishAt);

      // Whose queue this entry is in. Only shown for an account that is NOT the
      // reader — labelling their own posts "you" on every row would be noise, and
      // the absence of a label is already the clearest possible "mine".
      //
      // It deliberately names the ACCOUNT and never the person who queued it: a
      // channel's writers are anonymous unless it signs its posts, and that
      // decision is made on the server. When a channel DOES sign, the writer is
      // already in `authors[]` and the preview's byline draws them — so this row
      // never has to make a disclosure judgement of its own.
      // `viewerId` is checked FIRST and not merely compared: it is absent for the
      // moment between mount and the session landing, and `author.id !== undefined`
      // is true of every row — so comparing alone labels the reader's own posts as
      // somebody else's during exactly the window nobody watches.
      const author = item.user;
      const queuedFor =
        author !== undefined && viewerId !== undefined && author.id !== viewerId
          ? author.name?.displayName?.trim() || getNormalizedUserHandle(author) || undefined
          : undefined;

      return toElement(
        HStack(
          HStack(
            VStack(
              HStack(
                Icon(RiCalendarLine).size('14').foreground('primary'),
                RawText(timeLabel)
                  .font('xs')
                  .leading('16px')
                  .weight('semibold')
                  .foreground('primary'),
                queuedFor !== undefined
                  ? RawText(queuedFor)
                      .font('xs')
                      .leading('16px')
                      .foreground('muted')
                      .shrink('normal')
                      .label(
                        t('compose.scheduled.queuedForA11y', {
                          defaultValue: 'Queued for {{account}}',
                          account: queuedFor,
                        }),
                      )
                      .lines(1)
                  : null,
              )
                .align('center')
                .spacing('6')
                .margin('bottom', 'xs'),
              RawText(getPreview(item))
                .font('14')
                .leading('20px')
                .foreground('foreground')
                .margin('bottom', 'xs')
                .lines(2),
              Embed(
                (mediaCount > 0 || hasPoll) &&
                  toElement(
                    HStack(
                      mediaCount > 0
                        ? HStack(
                            Icon(RiImageLine).size('14').foreground('muted'),
                            RawText(mediaCount).font('xs').leading('16px').foreground('muted'),
                          )
                            .align('center')
                            .spacing('xs')
                        : null,
                      Embed(
                        hasPoll && toElement(Icon(RiListCheck3).size('14').foreground('muted')),
                      ),
                    )
                      .align('center')
                      .spacing('md')
                      .margin('top', 'xs'),
                  ),
              ),
            )
              .flex('1')
              .margin('right', 'md'),
            Icon(RiArrowRightSLine).size('md').foreground('muted'),
          )
            .flex('1')
            .align('center')
            .onPress(() => onPreview(item))
            .disabled(isCancelling)
            .role('button')
            .label(
              t('compose.scheduled.previewA11y', {
                defaultValue: 'Preview scheduled post',
              }),
            )
            .pressFade('70'),
          VStack(Icon(RiEditLine).size('18').foreground('muted'))
            .padding('xs')
            .margin('right', 'xs')
            .onPress(() => onEdit(item))
            .disabled(isCancelling)
            .hitSlop('lg')
            .role('button')
            .label(
              t('compose.scheduled.edit', {
                defaultValue: 'Edit scheduled post',
              }),
            )
            .pressFade('70'),
          VStack(
            isCancelling
              ? Loading().style('inline').size('sm')
              : Icon(RiDeleteBinLine).size('18').foreground('muted'),
          )
            .padding('xs')
            .onPress(() => handleCancel(item))
            .disabled(isCancelling)
            .hitSlop('lg')
            .role('button')
            .label(
              t('compose.scheduled.cancelTitle', {
                defaultValue: 'Cancel scheduled post',
              }),
            )
            .pressFade('70'),
        )
          .padding('horizontal', 'lg')
          .padding('vertical', 'md')
          .background('background')
          .border('border', 'thin', 'bottom')
          .align('center'),
      );
    },
    [cancellingId, getPreview, handleCancel, onEdit, onPreview, t, viewerId],
  );

  if (isLoading) {
    return <FeedSkeleton />;
  }

  if (isError) {
    return toElement(
      VStack(
        RawText(
          t('compose.scheduled.loadError', {
            defaultValue: "We couldn't load your scheduled posts",
          }),
        )
          .font('16')
          .leading('normal')
          .textAlign('center')
          .foreground('muted'),
        // The web's button never drew this margin; native's did.
        LButton(LText(t('common.retry', { defaultValue: 'Retry' })))
          .onPress(onRetry)
          .when('native', (v) => v.margin('top', 'lg')),
      )
        .padding('vertical', '48')
        .padding('horizontal', '3xl')
        .flex('1')
        .justify('center')
        .align('center'),
    );
  }

  if (posts.length === 0) {
    return (
      <EmptyState
        title={t('compose.scheduled.empty', { defaultValue: 'No scheduled posts' })}
        subtitle={t('compose.scheduled.emptyDescription', {
          defaultValue: 'Posts you schedule will wait here until it is time to publish them.',
        })}
        sticker="scheduledPosts"
        containerStyle={{ flex: 1, justifyContent: 'center' }}
      />
    );
  }

  return (
    <FlatList
      data={posts}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      style={styles.list}
    />
  );
};

const styles = StyleSheet.create({
  list: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
});

export default ScheduledPostsList;
