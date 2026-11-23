import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useState, useCallback } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEyeLine } from '@oxy.so/bloom/icons/RiEyeLine';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useTranslation } from 'react-i18next';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { HydratedPost } from '@mention/shared-types';
import { EmptyState } from '@/components/common/EmptyState';
import type { Draft } from '@/hooks/useDrafts';
import { DraftConflictError } from '@/utils/draftSession';
import { useDraftsList, type DraftListItem } from '@/hooks/useDraftsList';
import { toast } from '@oxy.so/bloom/toast';
import { confirmDialog } from '@/utils/alerts';
import { createLogger } from '@oxy.so/core/logger';
import {
  confirmAndDeleteServerDraft,
  confirmAndPublishDraft,
  otherDraftLanguages,
} from './serverDraftActions';

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

const logger = createLogger('DraftsList');

interface DraftsListProps {
  onLoadDraft: (draft: Draft) => void;
  /** Show how this draft will look once posted. */
  onPreviewDraft: (draft: Draft) => void;
  currentDraftId: string | null;
  /** Show how a draft saved to the account will look once published. */
  onPreviewServerDraft: (post: HydratedPost) => void;
  /** Open a draft saved to the account in the composer. */
  onEditServerDraft: (post: HydratedPost) => void;
}

/**
 * Every draft the viewer has, as ONE list, most recently changed first.
 *
 * A draft lives in one of two places today: on this DEVICE (what the composer
 * saves, persisted per viewer by `useDrafts`) or on the viewer's ACCOUNT (a post
 * stored with `status: 'draft'`, usually by an automation through the API or
 * MCP). The reader should not have to know that, so both render with the same
 * row and differ only in what their buttons do — a device draft loads into the
 * composer, an account draft can also be published outright. The one visible
 * difference is a quiet "On this device" on device rows, which is also the only
 * thing that goes away when device drafts move to the server.
 *
 * All of it comes from `useDraftsList`, so the follow-up that makes the server
 * the only home for drafts changes that hook, not this list.
 */
const DraftsList: React.FC<DraftsListProps> = ({
  onLoadDraft,
  onPreviewDraft,
  currentDraftId,
  onPreviewServerDraft,
  onEditServerDraft,
}) => {
  const { t } = useTranslation();
  const {
    items,
    isLoading,
    deviceError,
    refetchDeviceDrafts,
    serverLoading,
    serverError,
    refetchServerDrafts,
    publishServerDraft,
    deleteServerDraft,
    deleteDeviceDraft,
    viewerId,
  } = useDraftsList();
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleDeleteDeviceDraft = useCallback(
    async (draft: Draft) => {
      const draftId = draft.id;
      const confirmed = await confirmDialog({
        title: t('compose.deleteDraft'),
        message: t('compose.deleteDraftConfirm'),
        okText: t('common.delete'),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;

      try {
        setBusyId(draftId);
        await deleteDeviceDraft(draft);
        toast(t('compose.draftDeleted'), { type: 'success' });
      } catch (error) {
        logger.error('Error deleting draft', error);
        if (error instanceof DraftConflictError) {
          await refetchDeviceDrafts();
          toast(
            t('compose.deleteDraftChanged', {
              defaultValue: 'This draft changed. Review it and try deleting again.',
            }),
            { type: 'error' },
          );
        } else {
          toast(t('compose.deleteDraftError'), { type: 'error' });
        }
      } finally {
        setBusyId(null);
      }
    },
    [deleteDeviceDraft, refetchDeviceDrafts, t],
  );

  const handlePublishServerDraft = useCallback(
    async (post: HydratedPost) => {
      setBusyId(post.id);
      try {
        await confirmAndPublishDraft({ post, onPublish: publishServerDraft, t });
      } finally {
        setBusyId(null);
      }
    },
    [publishServerDraft, t],
  );

  const handleDeleteServerDraft = useCallback(
    async (post: HydratedPost) => {
      setBusyId(post.id);
      try {
        await confirmAndDeleteServerDraft({ post, onDelete: deleteServerDraft, t });
      } finally {
        setBusyId(null);
      }
    },
    [deleteServerDraft, t],
  );

  const formatDate = useCallback(
    (timestamp: number) => {
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) {
        return t('compose.justNow');
      } else if (diffMins < 60) {
        return t('compose.minutesAgo', { count: diffMins });
      } else if (diffHours < 24) {
        return t('compose.hoursAgo', { count: diffHours });
      } else if (diffDays < 7) {
        return t('compose.daysAgo', { count: diffDays });
      } else {
        return date.toLocaleDateString();
      }
    },
    [t],
  );

  const getDraftPreview = useCallback(
    (draft: Draft) => {
      if (draft.postContent.trim()) {
        return (
          draft.postContent.trim().substring(0, 100) + (draft.postContent.length > 100 ? '...' : '')
        );
      }
      if (draft.mediaIds.length > 0) {
        return t('compose.draftWithMedia', { count: draft.mediaIds.length });
      }
      if (draft.pollOptions.length > 0) {
        return t('compose.draftWithPoll');
      }
      if (
        draft.article &&
        ((draft.article.title && draft.article.title.trim().length > 0) ||
          (draft.article.body && draft.article.body.trim().length > 0))
      ) {
        return (
          draft.article.title?.trim() ||
          t('compose.draftWithArticle', { defaultValue: 'Draft with article' })
        );
      }
      if (draft.event?.name?.trim()) {
        return draft.event.name.trim();
      }
      if (draft.room?.title?.trim()) {
        return draft.room.title.trim();
      }
      if (draft.threadItems.length > 0) {
        const totalPosts = draft.threadItems.length + 1;
        return t('compose.draftWithThread', { count: totalPosts });
      }
      return t('compose.emptyDraft');
    },
    [t],
  );

  // The same fallbacks as a device draft, read off the hydrated post: the text
  // hydration already resolved for this reader, then the article, media, poll.
  const getServerDraftPreview = useCallback(
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
    ({ item }: { item: DraftListItem }) => {
      const isServer = item.origin === 'server';
      const isCurrentDraft = !isServer && item.id === currentDraftId;
      const isBusy = busyId === item.id;

      const preview = isServer ? getServerDraftPreview(item.post) : getDraftPreview(item.draft);
      const mediaCount = isServer
        ? (item.post.content?.media?.length ?? 0)
        : item.draft.mediaIds.length;
      const threadCount = isServer ? 0 : item.draft.threadItems.length;
      const otherLanguages = isServer ? otherDraftLanguages(item.post) : [];

      // Whose draft this is, only when it belongs to a channel the reader operates
      // rather than to the reader — the scheduled list's "queued for" rule.
      const author = isServer ? item.post.user : undefined;
      const draftedFor =
        author !== undefined && viewerId !== undefined && author.id !== viewerId
          ? author.name?.displayName?.trim() || getNormalizedUserHandle(author) || undefined
          : undefined;

      const open = () => (isServer ? onEditServerDraft(item.post) : onLoadDraft(item.draft));
      const openPreview = () =>
        isServer ? onPreviewServerDraft(item.post) : onPreviewDraft(item.draft);
      const remove = () =>
        isServer ? handleDeleteServerDraft(item.post) : handleDeleteDeviceDraft(item.draft);

      // The current-draft tint is `bg-primary/10`, not
      // `theme.colors.primary + '15'`: that token is an `rgb(...)` string, so a
      // hex-alpha suffix reads back fully opaque and the row the user is editing
      // paints solid primary under its own foreground text.
      return toElement(
        HStack(
          HStack(
            VStack(
              HStack(
                HStack(
                  Embed(
                    isCurrentDraft &&
                      toElement(
                        VStack(
                          RawText(t('compose.current'))
                            .font('2xs')
                            .weight('semibold')
                            .foreground('card'),
                        )
                          .padding('horizontal', '6')
                          .padding('vertical', '2xs')
                          .background('primary')
                          .corner('xs'),
                      ),
                  ),
                  RawText(formatDate(item.updatedAt))
                    .font('xs')
                    .leading('16px')
                    .foreground('muted'),
                  !isServer
                    ? RawText(t('compose.draftOnThisDevice', { defaultValue: 'On this device' }))
                        .font('xs')
                        .leading('16px')
                        .foreground('muted')
                    : null,
                  draftedFor !== undefined
                    ? RawText(draftedFor)
                        .font('xs')
                        .leading('16px')
                        .foreground('muted')
                        .shrink('normal')
                        .lines(1)
                    : null,
                )
                  .align('center')
                  .spacing('sm')
                  .shrink('normal'),
              )
                .justify('between')
                .align('center')
                .margin('bottom', 'xs'),
              RawText(preview)
                .font('14')
                .leading('20px')
                .foreground('foreground')
                .margin('bottom', 'xs')
                .lines(2),
              mediaCount > 0 || threadCount > 0 || otherLanguages.length > 0
                ? HStack(
                    mediaCount > 0
                      ? HStack(
                          Icon(RiImageLine).size('14').foreground('muted'),
                          RawText(mediaCount).font('xs').leading('16px').foreground('muted'),
                        )
                          .align('center')
                          .spacing('xs')
                      : null,
                    threadCount > 0
                      ? HStack(
                          Icon(RiFileCopyLine).size('14').foreground('muted'),
                          RawText(threadCount + 1)
                            .font('xs')
                            .leading('16px')
                            .foreground('muted'),
                        )
                          .align('center')
                          .spacing('xs')
                      : null,
                    otherLanguages.length > 0
                      ? HStack(
                          Icon(RiGlobalLine).size('14').foreground('muted'),
                          RawText(
                            t('compose.serverDrafts.alsoIn', {
                              defaultValue: 'Also in {{languages}}',
                              languages: otherLanguages.join(', '),
                            }),
                          )
                            .font('xs')
                            .leading('16px')
                            .foreground('muted')
                            .shrink('normal')
                            .lines(1),
                        )
                          .align('center')
                          .spacing('xs')
                          .shrink('normal')
                      : null,
                  )
                    .align('center')
                    .spacing('md')
                    .margin('top', 'xs')
                : null,
            )
              .flex('1')
              .margin('right', 'md'),
            Icon(RiArrowRightSLine).size('md').foreground('muted'),
          )
            .flex('1')
            .align('center')
            .onPress(open)
            .disabled(isBusy)
            .role('button')
            .label(
              t('compose.draftPreviewEdit', {
                defaultValue: 'Continue writing',
              }),
            )
            .pressFade(),
          isServer
            ? VStack(Icon(RiSendPlaneLine).size('18').foreground('primary'))
                .padding('xs')
                .margin('right', 'xs')
                .onPress(() => handlePublishServerDraft(item.post))
                .disabled(isBusy)
                .hitSlop('lg')
                .role('button')
                .label(
                  t('compose.serverDrafts.publishTitle', {
                    defaultValue: 'Publish draft',
                  }),
                )
                .pressFade('70')
            : null,
          VStack(Icon(RiEyeLine).size('18').foreground('muted'))
            .padding('xs')
            .margin('right', 'xs')
            .onPress(openPreview)
            .disabled(isBusy)
            .hitSlop('lg')
            .role('button')
            .label(t('compose.draftPreviewA11y', { defaultValue: 'Preview draft' }))
            .pressFade('70'),
          VStack(
            isBusy
              ? Loading().style('inline').size('sm')
              : Icon(RiDeleteBinLine).size('18').foreground('muted'),
          )
            .padding('xs')
            .onPress(remove)
            .disabled(isBusy)
            .hitSlop('lg')
            .role('button')
            .label(t('compose.deleteDraft'))
            .pressFade('70'),
        )
          .padding('horizontal', 'lg')
          .padding('vertical', 'md')
          .background(isCurrentDraft ? 'primary/10' : 'background')
          .border('border', 'thin', 'bottom')
          .align('center'),
      );
    },
    [
      busyId,
      currentDraftId,
      formatDate,
      getDraftPreview,
      getServerDraftPreview,
      handleDeleteDeviceDraft,
      handleDeleteServerDraft,
      handlePublishServerDraft,
      onEditServerDraft,
      onLoadDraft,
      onPreviewDraft,
      onPreviewServerDraft,
      t,
      viewerId,
    ],
  );

  if (isLoading) {
    return <FeedSkeleton />;
  }

  // The account half reports beside the rows rather than instead of them: a
  // slow or failed server read must not hide the drafts already on this device.
  const serverStatus = serverError ? (
    toElement(
      VStack(
        RawText(
          t('compose.serverDrafts.loadError', {
            defaultValue: "We couldn't load the drafts saved to your account",
          }),
        )
          .font('14')
          .leading('20px')
          .textAlign('center')
          .foreground('muted'),
        // The web's button never drew this margin; native's did.
        LButton(LText(t('common.retry', { defaultValue: 'Retry' })))
          .onPress(refetchServerDrafts)
          .when('native', (v) => v.margin('top', 'md')),
      )
        .padding('vertical', 'lg')
        .padding('horizontal', '3xl')
        .border('border', 'thin', 'bottom')
        .align('center'),
    )
  ) : serverLoading ? (
    <FeedSkeleton count={2} />
  ) : undefined;

  const deviceStatus = deviceError
    ? toElement(
        VStack(
          RawText(
            t('compose.deviceDrafts.loadError', {
              defaultValue: "We couldn't load the drafts saved on this device",
            }),
          )
            .font('14')
            .leading('20px')
            .textAlign('center')
            .foreground('muted'),
          // The web's button never drew this margin; native's did.
          LButton(LText(t('common.retry', { defaultValue: 'Retry' })))
            .onPress(refetchDeviceDrafts)
            .when('native', (v) => v.margin('top', 'md')),
        )
          .padding('vertical', 'lg')
          .padding('horizontal', '3xl')
          .border('border', 'thin', 'bottom')
          .align('center'),
      )
    : undefined;

  if (items.length === 0 && serverStatus === undefined && deviceStatus === undefined) {
    return (
      <EmptyState
        title={t('compose.noDrafts')}
        subtitle={t('compose.noDraftsDescription')}
        sticker="drafts"
        containerStyle={{ flex: 1, justifyContent: 'center' }}
      />
    );
  }

  return (
    <FlatList
      data={items}
      renderItem={renderItem}
      // Prefixed by origin: a device draft's id and a post id come from
      // different generators, and nothing promises they never meet.
      keyExtractor={(item) => `${item.origin}:${item.id}`}
      ListHeaderComponent={
        serverStatus || deviceStatus ? (
          <>
            {deviceStatus}
            {serverStatus}
          </>
        ) : undefined
      }
      style={styles.list}
    />
  );
};

const styles = StyleSheet.create({
  list: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
});

export default DraftsList;
