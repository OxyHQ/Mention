import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, ActivityIndicator } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { DraftsIcon } from '@/assets/icons/drafts';
import { useDrafts, Draft } from '@/hooks/useDrafts';
import { toast } from 'sonner';

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

  const handleDeleteDraft = useCallback((draftId: string) => {
    Alert.alert(
      t('compose.deleteDraft'),
      t('compose.deleteDraftConfirm'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
        },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              setDeletingId(draftId);
              await deleteDraft(draftId);
              await loadDrafts(); // Refresh list
              toast.success(t('compose.draftDeleted'));
            } catch (error) {
              console.error('Error deleting draft:', error);
              toast.error(t('compose.deleteDraftError'));
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
      { cancelable: true }
    );
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
      <TouchableOpacity
        style={[
          styles.draftItem,
          { 
            backgroundColor: theme.colors.background,
            borderBottomColor: theme.colors.border,
          },
          isCurrentDraft && { backgroundColor: theme.colors.primary + '15' }
        ]}
        onPress={() => handleLoadDraft(item)}
        disabled={isDeleting}
      >
        <View style={styles.draftContent}>
          <View style={styles.draftHeader}>
            <View style={styles.draftInfo}>
              {isCurrentDraft && (
                <View style={[styles.currentBadge, { backgroundColor: theme.colors.primary }]}>
                  <Text style={[styles.currentBadgeText, { color: theme.colors.card }]}>
                    {t('compose.current')}
                  </Text>
                </View>
              )}
              <Text style={[styles.draftDate, { color: theme.colors.textSecondary }]}>
                {formatDate(item.updatedAt)}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => handleDeleteDraft(item.id)}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" color={theme.colors.error} />
              ) : (
                <Ionicons name="trash-outline" size={18} color={theme.colors.textSecondary} />
              )}
            </TouchableOpacity>
          </View>
          <Text 
            style={[styles.draftPreview, { color: theme.colors.text }]} 
            numberOfLines={2}
          >
            {getDraftPreview(item)}
          </Text>
          {(item.mediaIds.length > 0 || item.threadItems.length > 0) && (
            <View style={styles.draftMeta}>
              {item.mediaIds.length > 0 && (
                <View style={styles.metaItem}>
                  <Ionicons name="image-outline" size={14} color={theme.colors.textSecondary} />
                  <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                    {item.mediaIds.length}
                  </Text>
                </View>
              )}
              {item.threadItems.length > 0 && (
                <View style={styles.metaItem}>
                  <Ionicons name="layers-outline" size={14} color={theme.colors.textSecondary} />
                  <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                    {item.threadItems.length + 1}
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
        <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
      </TouchableOpacity>
    );
  }, [theme, currentDraftId, deletingId, handleLoadDraft, handleDeleteDraft, formatDate, getDraftPreview, t]);

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            {t('compose.drafts')}
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color={theme.colors.text} />
          </TouchableOpacity>
        </View>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('compose.drafts')}
        </Text>
        <TouchableOpacity onPress={onClose}>
          <Ionicons name="close" size={24} color={theme.colors.text} />
        </TouchableOpacity>
      </View>
      
      {drafts.length === 0 ? (
        <View style={styles.emptyContainer}>
          <DraftsIcon size={64} color={theme.colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
            {t('compose.noDrafts')}
          </Text>
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
            {t('compose.noDraftsDescription')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={drafts}
          renderItem={renderDraftItem}
          keyExtractor={(item) => item.id}
          style={styles.list}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 16,
    maxHeight: 600,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    marginTop: 24,
    fontSize: 20,
    fontWeight: '600',
  },
  emptyText: {
    marginTop: 8,
    fontSize: 16,
    textAlign: 'center',
  },
  list: {
    flex: 1,
  },
  draftItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'transparent',
  },
  draftContent: {
    flex: 1,
    marginRight: 12,
  },
  draftHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  draftInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  currentBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  currentBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  draftDate: {
    fontSize: 12,
  },
  deleteButton: {
    padding: 4,
  },
  draftPreview: {
    fontSize: 14,
    marginBottom: 4,
  },
  draftMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
  },
});

export default DraftsSheet;
