import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import type { Draft } from '@/hooks/useDrafts';
import { useScheduledPosts } from '@/hooks/useScheduledPosts';
import DraftsList from './DraftsList';
import ScheduledPostsList from './ScheduledPostsList';

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
 */
const UnpublishedSheet: React.FC<UnpublishedSheetProps> = ({
  onClose,
  onLoadDraft,
  currentDraftId,
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<UnpublishedTab>('drafts');
  const { scheduledPosts, isLoading, isError, refetch, cancelScheduledPost } = useScheduledPosts();

  const showDrafts = useCallback(() => setActiveTab('drafts'), []);
  const showScheduled = useCallback(() => setActiveTab('scheduled'), []);

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
        <DraftsList onLoadDraft={onLoadDraft} currentDraftId={currentDraftId} />
      ) : (
        <ScheduledPostsList
          posts={scheduledPosts}
          isLoading={isLoading}
          isError={isError}
          onRetry={refetch}
          onCancel={cancelScheduledPost}
        />
      )}
    </View>
  );
};

export default UnpublishedSheet;
