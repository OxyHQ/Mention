import React, { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import type { HydratedPost } from '@mention/shared-types';
import type { Draft } from '@/hooks/useDrafts';
import { useScheduledPosts } from '@/hooks/useScheduledPosts';
import DraftsList from './DraftsList';
import ScheduledPostsList from './ScheduledPostsList';
import ScheduledPostPreview from './ScheduledPostPreview';
import DraftPreview from './DraftPreview';

export type UnpublishedTab = 'drafts' | 'scheduled';

interface UnpublishedSheetProps {
  onClose: () => void;
  onLoadDraft: (draft: Draft) => void;
  currentDraftId: string | null;
}

interface TabButtonProps {
  label: string;
  count?: number;
  isActive: boolean;
  onPress: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, count, isActive, onPress }) => {
  const theme = useTheme();

  return (
    <TouchableOpacity
      className="flex-1 flex-row items-center justify-center gap-1.5 py-3 border-b-2"
      style={{ borderBottomColor: isActive ? theme.colors.primary : 'transparent' }}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
    >
      <Text
        className="text-[15px] font-semibold"
        style={{ color: isActive ? theme.colors.primary : theme.colors.textSecondary }}
      >
        {label}
      </Text>
      {count !== undefined && count > 0 && (
        <View
          className="min-w-5 px-1.5 py-0.5 rounded-full items-center"
          style={{ backgroundColor: isActive ? theme.colors.primary : theme.colors.border }}
        >
          <Text
            className="text-[11px] font-semibold"
            style={{ color: isActive ? theme.colors.card : theme.colors.textSecondary }}
          >
            {count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
};

/**
 * Everything the viewer has written but not published, in one sheet.
 *
 * Drafts and scheduled posts are the same shelf from the user's point of view —
 * "things I wrote that aren't out yet" — so they are two TABS rather than two
 * sheets behind two header icons. That is also the shortest fix for how this
 * surface was found missing: people went looking for their scheduled posts in
 * the drafts sheet, which is precisely where the tab now sits.
 *
 * The scheduled query lives here, not in the list, so the tab can show its count
 * (and warm the cache) while the drafts tab is the one on screen.
 *
 * Previewing a scheduled post REPLACES the sheet's body rather than opening a
 * second sheet on top of this one: the preview is a deeper level of the same
 * shelf, and stacking sheets buys nothing but a second dismiss gesture.
 */
const UnpublishedSheet: React.FC<UnpublishedSheetProps> = ({
  onClose,
  onLoadDraft,
  currentDraftId,
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<UnpublishedTab>('drafts');
  const [previewPostId, setPreviewPostId] = useState<string | null>(null);
  // A draft is LOCAL, so unlike a scheduled post there is no server list to look
  // it back up in — the draft object itself is the only handle there is.
  const [previewDraft, setPreviewDraft] = useState<Draft | null>(null);
  const {
    scheduledPosts,
    isLoading,
    isError,
    refetch,
    cancelScheduledPost,
    publishScheduledPostNow,
  } = useScheduledPosts();

  const showDrafts = useCallback(() => setActiveTab('drafts'), []);
  const showScheduled = useCallback(() => setActiveTab('scheduled'), []);

  const openPreview = useCallback((post: HydratedPost) => setPreviewPostId(post.id), []);
  const closePreview = useCallback(() => setPreviewPostId(null), []);
  const openDraftPreview = useCallback((draft: Draft) => setPreviewDraft(draft), []);
  const closeDraftPreview = useCallback(() => setPreviewDraft(null), []);

  /**
   * Editing reuses the composer's OWN edit route rather than the drafts loader.
   * `onLoadDraft` restores a LOCAL draft — a different shape, with no post id —
   * so saving it would create a second post and leave the scheduled one behind.
   * `/compose?editPostId=` already loads a server post through
   * `GET /posts/:id/edit-source` and saves through `PUT /posts/:id`, which is
   * exactly the update this needs.
   */
  const editPost = useCallback((post: HydratedPost) => {
    onClose();
    router.push(`/compose?editPostId=${encodeURIComponent(post.id)}`);
  }, [onClose, router]);

  // Held by ID, not by value: a refetch (or the cancel that drops a row) must be
  // able to take the preview down or refresh it, which a captured object could
  // not do — it would keep rendering a post the server no longer has.
  const previewPost = previewPostId === null
    ? undefined
    : scheduledPosts.find((post) => post.id === previewPostId);

  if (previewDraft) {
    return (
      <View className="flex-1 max-h-[600px] bg-background">
        <DraftPreview
          draft={previewDraft}
          onBack={closeDraftPreview}
          onEdit={() => {
            closeDraftPreview();
            onLoadDraft(previewDraft);
          }}
        />
      </View>
    );
  }

  if (previewPost) {
    return (
      <View className="flex-1 max-h-[600px] bg-background">
        <ScheduledPostPreview
          post={previewPost}
          onBack={closePreview}
          onEdit={() => editPost(previewPost)}
          onPublishNow={publishScheduledPostNow}
          onCancel={cancelScheduledPost}
          onCancelled={closePreview}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 max-h-[600px] bg-background">
      <Header
        options={{
          title: t('compose.unpublished', { defaultValue: 'Unpublished' }),
          rightComponents: [
            <IconButton variant="icon" key="close" onPress={onClose}>
              <CloseIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <View className="flex-row border-b border-border" accessibilityRole="tablist">
        <TabButton
          label={t('compose.drafts')}
          isActive={activeTab === 'drafts'}
          onPress={showDrafts}
        />
        <TabButton
          label={t('compose.scheduled.tab', { defaultValue: 'Scheduled' })}
          count={scheduledPosts.length}
          isActive={activeTab === 'scheduled'}
          onPress={showScheduled}
        />
      </View>

      {activeTab === 'drafts' ? (
        <DraftsList
          onLoadDraft={onLoadDraft}
          onPreviewDraft={openDraftPreview}
          currentDraftId={currentDraftId}
        />
      ) : (
        <ScheduledPostsList
          posts={scheduledPosts}
          isLoading={isLoading}
          isError={isError}
          onRetry={refetch}
          onPreview={openPreview}
          onEdit={editPost}
          onCancel={cancelScheduledPost}
        />
      )}
    </View>
  );
};

export default UnpublishedSheet;
