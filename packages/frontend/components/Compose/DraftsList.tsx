import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
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
import { DraftsIcon } from '@/assets/icons/drafts';
import type { Draft } from '@/hooks/useDrafts';
import { useDraftsList, type DraftListItem } from '@/hooks/useDraftsList';
import { toast } from '@oxy.so/bloom/toast';
import { confirmDialog } from '@/utils/alerts';
import { createLogger } from '@oxy.so/core/logger';
import { HIT_SLOP_LG } from '@/styles/hitSlop';
import {
  confirmAndDeleteServerDraft,
  confirmAndPublishDraft,
  otherDraftLanguages,
} from './serverDraftActions';

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
  const theme = useTheme();
  const { t } = useTranslation();
  const {
    items,
    isLoading,
    serverLoading,
    serverError,
    refetchServerDrafts,
    publishServerDraft,
    deleteServerDraft,
    deleteDeviceDraft,
    viewerId,
  } = useDraftsList();
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleDeleteDeviceDraft = useCallback(async (draftId: string) => {
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
      await deleteDeviceDraft(draftId);
      toast(t('compose.draftDeleted'), { type: 'success' });
    } catch (error) {
      logger.error('Error deleting draft', error);
      toast(t('compose.deleteDraftError'), { type: 'error' });
    } finally {
      setBusyId(null);
    }
  }, [deleteDeviceDraft, t]);

  const handlePublishServerDraft = useCallback(async (post: HydratedPost) => {
    setBusyId(post.id);
    try {
      await confirmAndPublishDraft({ post, onPublish: publishServerDraft, t });
    } finally {
      setBusyId(null);
    }
  }, [publishServerDraft, t]);

  const handleDeleteServerDraft = useCallback(async (post: HydratedPost) => {
    setBusyId(post.id);
    try {
      await confirmAndDeleteServerDraft({ post, onDelete: deleteServerDraft, t });
    } finally {
      setBusyId(null);
    }
  }, [deleteServerDraft, t]);

  const formatDate = useCallback((timestamp: number) => {
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
  }, [t]);

  const getDraftPreview = useCallback((draft: Draft) => {
    if (draft.postContent.trim()) {
      return draft.postContent.trim().substring(0, 100) + (draft.postContent.length > 100 ? '...' : '');
    }
    if (draft.mediaIds.length > 0) {
      return t('compose.draftWithMedia', { count: draft.mediaIds.length });
    }
    if (draft.pollOptions.length > 0) {
      return t('compose.draftWithPoll');
    }
    if (draft.article && ((draft.article.title && draft.article.title.trim().length > 0) || (draft.article.body && draft.article.body.trim().length > 0))) {
      return draft.article.title?.trim() || t('compose.draftWithArticle', { defaultValue: 'Draft with article' });
    }
    if (draft.threadItems.length > 0) {
      const totalPosts = draft.threadItems.length + 1;
      return t('compose.draftWithThread', { count: totalPosts });
    }
    return t('compose.emptyDraft');
  }, [t]);

  // The same fallbacks as a device draft, read off the hydrated post: the text
  // hydration already resolved for this reader, then the article, media, poll.
  const getServerDraftPreview = useCallback((post: HydratedPost) => {
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
  }, [t]);

  const renderItem = useCallback(({ item }: { item: DraftListItem }) => {
    const isServer = item.origin === 'server';
    const isCurrentDraft = !isServer && item.id === currentDraftId;
    const isBusy = busyId === item.id;

    const preview = isServer ? getServerDraftPreview(item.post) : getDraftPreview(item.draft);
    const mediaCount = isServer ? item.post.content?.media?.length ?? 0 : item.draft.mediaIds.length;
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
    const openPreview = () => (isServer ? onPreviewServerDraft(item.post) : onPreviewDraft(item.draft));
    const remove = () => (isServer ? handleDeleteServerDraft(item.post) : handleDeleteDeviceDraft(item.id));

    // The current-draft tint is `bg-primary/10`, not
    // `theme.colors.primary + '15'`: that token is an `rgb(...)` string, so a
    // hex-alpha suffix reads back fully opaque and the row the user is editing
    // paints solid primary under its own foreground text.
    return (
      <View
        className={`flex-row items-center px-4 py-3 border-b border-border ${isCurrentDraft ? 'bg-primary/10' : 'bg-background'}`}
      >
        <TouchableOpacity
          className="flex-1 flex-row items-center"
          onPress={open}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={t('compose.draftPreviewEdit', { defaultValue: 'Continue writing' })}
        >
          <View className="flex-1 mr-3">
            <View className="flex-row justify-between items-center mb-1">
              <View className="flex-row items-center gap-2 flex-shrink">
                {isCurrentDraft && (
                  <View className="px-1.5 py-0.5 rounded bg-primary">
                    <Text className="text-[10px] font-semibold" style={{ color: theme.colors.card }}>
                      {t('compose.current')}
                    </Text>
                  </View>
                )}
                <Text className="text-xs text-muted-foreground">
                  {formatDate(item.updatedAt)}
                </Text>
                {!isServer && (
                  <Text className="text-xs text-muted-foreground">
                    {t('compose.draftOnThisDevice', { defaultValue: 'On this device' })}
                  </Text>
                )}
                {draftedFor !== undefined && (
                  <Text className="text-xs text-muted-foreground flex-shrink" numberOfLines={1}>
                    {draftedFor}
                  </Text>
                )}
              </View>
            </View>
            <Text
              className="text-sm text-foreground mb-1"
              numberOfLines={2}
            >
              {preview}
            </Text>
            {(mediaCount > 0 || threadCount > 0 || otherLanguages.length > 0) && (
              <View className="flex-row items-center gap-3 mt-1">
                {mediaCount > 0 && (
                  <View className="flex-row items-center gap-1">
                    <RiImageLine width={14} height={14} fill={theme.colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground">
                      {mediaCount}
                    </Text>
                  </View>
                )}
                {threadCount > 0 && (
                  <View className="flex-row items-center gap-1">
                    <RiFileCopyLine width={14} height={14} fill={theme.colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground">
                      {threadCount + 1}
                    </Text>
                  </View>
                )}
                {otherLanguages.length > 0 && (
                  <View className="flex-row items-center gap-1 flex-shrink">
                    <RiGlobalLine width={14} height={14} fill={theme.colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground flex-shrink" numberOfLines={1}>
                      {t('compose.serverDrafts.alsoIn', {
                        defaultValue: 'Also in {{languages}}',
                        languages: otherLanguages.join(', '),
                      })}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <RiArrowRightSLine size="md" fill={theme.colors.textSecondary} />
        </TouchableOpacity>
        {isServer && (
          <TouchableOpacity
            className="p-1 mr-1"
            onPress={() => handlePublishServerDraft(item.post)}
            disabled={isBusy}
            hitSlop={HIT_SLOP_LG}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('compose.serverDrafts.publishTitle', { defaultValue: 'Publish draft' })}
          >
            <RiSendPlaneLine width={18} height={18} fill={theme.colors.primary} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          className="p-1 mr-1"
          onPress={openPreview}
          disabled={isBusy}
          hitSlop={HIT_SLOP_LG}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('compose.draftPreviewA11y', { defaultValue: 'Preview draft' })}
        >
          <RiEyeLine width={18} height={18} fill={theme.colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          className="p-1"
          onPress={remove}
          disabled={isBusy}
          hitSlop={HIT_SLOP_LG}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('compose.deleteDraft')}
        >
          {isBusy ? (
            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <RiDeleteBinLine width={18} height={18} fill={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
      </View>
    );
  }, [
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
    theme,
    viewerId,
  ]);

  if (isLoading) {
    return (
      <View className="flex-1 justify-center items-center py-12">
        <Loading className="text-primary" size="large" />
      </View>
    );
  }

  // The account half reports beside the rows rather than instead of them: a
  // slow or failed server read must not hide the drafts already on this device.
  const serverStatus = serverError ? (
    <View className="items-center py-4 px-8 border-b border-border">
      <Text className="text-sm text-center text-muted-foreground">
        {t('compose.serverDrafts.loadError', { defaultValue: "We couldn't load the drafts saved to your account" })}
      </Text>
      <Button className="mt-3" onPress={refetchServerDrafts}>
        {t('common.retry', { defaultValue: 'Retry' })}
      </Button>
    </View>
  ) : serverLoading ? (
    <View className="items-center py-4">
      <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
    </View>
  ) : null;

  if (items.length === 0 && serverStatus === null) {
    return (
      <View className="flex-1 justify-center items-center py-12 px-8">
        <DraftsIcon size={64} className="text-muted-foreground" />
        <Text className="mt-6 text-xl font-semibold text-foreground">
          {t('compose.noDrafts')}
        </Text>
        <Text className="mt-2 text-base text-center text-muted-foreground">
          {t('compose.noDraftsDescription')}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      renderItem={renderItem}
      // Prefixed by origin: a device draft's id and a post id come from
      // different generators, and nothing promises they never meet.
      keyExtractor={(item) => `${item.origin}:${item.id}`}
      ListHeaderComponent={serverStatus}
      className="flex-1"
    />
  );
};

export default DraftsList;
