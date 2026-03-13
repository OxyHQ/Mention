import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { DraftsIcon } from '@/assets/icons/drafts';
import { useDrafts, Draft } from '@/hooks/useDrafts';
import { toast } from 'sonner';
import { confirmDialog } from '@/utils/alerts';
interface DraftsSheetProps {
  onClose: () => void;
  onLoadDraft: (draft: Draft) => void;
  currentDraftId: string | null;
}

const DraftsSheet: React.FC<DraftsSheetProps> = ({ onClose, onLoadDraft, currentDraftId }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { drafts, isLoading, deleteDraft, loadDrafts } = useDrafts();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleLoadDraft = useCallback((draft: Draft) => {
    onLoadDraft(draft);
  }, [onLoadDraft]);

  const handleDeleteDraft = useCallback(async (draftId: string) => {
    console.log('handleDeleteDraft called with draftId:', draftId);
    const confirmed = await confirmDialog({
      title: t('compose.deleteDraft'),
      message: t('compose.deleteDraftConfirm'),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      destructive: true,
    });

    if (!confirmed) {
      console.log('Delete cancelled');
      return;
    }

    console.log('Delete confirmed, deleting draft:', draftId);
    try {
      setDeletingId(draftId);
      console.log('Calling deleteDraft...');
      await deleteDraft(draftId);
      console.log('deleteDraft completed, reloading drafts...');
      // Reload drafts to ensure UI is updated
      await loadDrafts();
      console.log('Drafts reloaded');
      toast.success(t('compose.draftDeleted'));
    } catch (error) {
      console.error('Error deleting draft:', error);
      toast.error(t('compose.deleteDraftError'));
    } finally {
      setDeletingId(null);
    }
  }, [deleteDraft, loadDrafts, t]);

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
      return diffMins === 1
        ? t('compose.minutesAgo', { count: diffMins })
        : t('compose.minutesAgo_plural', { count: diffMins });
    } else if (diffHours < 24) {
      return diffHours === 1
        ? t('compose.hoursAgo', { count: diffHours })
        : t('compose.hoursAgo_plural', { count: diffHours });
    } else if (diffDays < 7) {
      return diffDays === 1
        ? t('compose.daysAgo', { count: diffDays })
        : t('compose.daysAgo_plural', { count: diffDays });
    } else {
      return date.toLocaleDateString();
    }
  }, [t]);

  const getDraftPreview = useCallback((draft: Draft) => {
    if (draft.postContent.trim()) {
      return draft.postContent.trim().substring(0, 100) + (draft.postContent.length > 100 ? '...' : '');
    }
    if (draft.mediaIds.length > 0) {
      return draft.mediaIds.length === 1
        ? t('compose.draftWithMedia', { count: draft.mediaIds.length })
        : t('compose.draftWithMedia_plural', { count: draft.mediaIds.length });
    }
    if (draft.pollOptions.length > 0) {
      return t('compose.draftWithPoll');
    }
    if (draft.article && ((draft.article.title && draft.article.title.trim().length > 0) || (draft.article.body && draft.article.body.trim().length > 0))) {
      return draft.article.title?.trim() || t('compose.draftWithArticle', { defaultValue: 'Draft with article' });
    }
    if (draft.threadItems.length > 0) {
      const totalPosts = draft.threadItems.length + 1;
      return totalPosts === 2
        ? t('compose.draftWithThread', { count: totalPosts })
        : t('compose.draftWithThread_plural', { count: totalPosts });
    }
    return t('compose.emptyDraft');
  }, [t]);

  const renderDraftItem = useCallback(({ item }: { item: Draft }) => {
    const isCurrentDraft = item.id === currentDraftId;
    const isDeleting = deletingId === item.id;

    return (
      <View
        className="flex-row items-center px-4 py-3 bg-background border-b border-border"
        style={isCurrentDraft ? { backgroundColor: theme.colors.primary + '15' } : undefined}
      >
        <TouchableOpacity
          className="flex-1 flex-row items-center"
          onPress={() => handleLoadDraft(item)}
          disabled={isDeleting}
        >
          <View className="flex-1 mr-3">
            <View className="flex-row justify-between items-center mb-1">
              <View className="flex-row items-center gap-2">
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
              </View>
            </View>
            <Text
              className="text-sm text-foreground mb-1"
              numberOfLines={2}
            >
              {getDraftPreview(item)}
            </Text>
            {(item.mediaIds.length > 0 || item.threadItems.length > 0) && (
              <View className="flex-row items-center gap-3 mt-1">
                {item.mediaIds.length > 0 && (
                  <View className="flex-row items-center gap-1">
                    <Ionicons name="image-outline" size={14} color={theme.colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground">
                      {item.mediaIds.length}
                    </Text>
                  </View>
                )}
                {item.threadItems.length > 0 && (
                  <View className="flex-row items-center gap-1">
                    <Ionicons name="layers-outline" size={14} color={theme.colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground">
                      {item.threadItems.length + 1}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
          <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          className="p-1"
          onPress={() => {
            console.log('Delete button pressed for draft:', item.id);
            handleDeleteDraft(item.id);
          }}
          disabled={isDeleting}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
        >
          {isDeleting ? (
            <Loading variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Ionicons name="trash-outline" size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
      </View>
    );
  }, [theme, currentDraftId, deletingId, handleLoadDraft, handleDeleteDraft, formatDate, getDraftPreview, t]);

  if (isLoading) {
    return (
      <View className="flex-1 max-h-[600px] bg-background">
        <Header
          options={{
            title: t('compose.drafts'),
            rightComponents: [
              <IconButton variant="icon"
                key="close"
                onPress={onClose}
              >
                <CloseIcon size={20} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />
        <View className="flex-1 justify-center items-center py-12">
          <Loading size="large" />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 max-h-[600px] bg-background">
      <Header
        options={{
          title: t('compose.drafts'),
          rightComponents: [
            <IconButton variant="icon"
              key="close"
              onPress={onClose}
            >
              <CloseIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      {drafts.length === 0 ? (
        <View className="flex-1 justify-center items-center py-12 px-8">
          <DraftsIcon size={64} color={theme.colors.textSecondary} />
          <Text className="mt-6 text-xl font-semibold text-foreground">
            {t('compose.noDrafts')}
          </Text>
          <Text className="mt-2 text-base text-center text-muted-foreground">
            {t('compose.noDraftsDescription')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={drafts}
          renderItem={renderDraftItem}
          keyExtractor={(item) => item.id}
          className="flex-1"
        />
      )}
    </View>
  );
};

export default DraftsSheet;
