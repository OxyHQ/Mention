import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';

import { RowIcon } from '@/components/settings/RowIcon';
import { ThreadSortGroup } from '@/components/settings/ThreadSortGroup';
import { useThreadPreferencesStore } from '@/hooks/useThreadPreferences';

export default function ReplyPreferencesSheet() {
  const { t } = useTranslation();
  const treeView = useThreadPreferencesStore((state) => state.treeView);
  const setTreeView = useThreadPreferencesStore((state) => state.setTreeView);

  return (
    <ScrollView contentContainerClassName="px-4 pt-2 pb-8" showsVerticalScrollIndicator={false}>
      <GroupedSection
        title={t('replyPreferences.showRepliesAs', { defaultValue: 'Show replies as' })}
      >
        <GroupedSectionItem
          icon={<RowIcon icon={RiListUnordered} />}
          title={t('replyPreferences.linear', { defaultValue: 'Linear' })}
          rightElement={<RadioIndicator selected={!treeView} />}
          showChevron={false}
          onPress={() => setTreeView(false)}
        />
        <GroupedSectionItem
          icon={<RowIcon icon={RiNodeTree} />}
          title={t('replyPreferences.threaded', { defaultValue: 'Threaded' })}
          rightElement={<RadioIndicator selected={treeView} />}
          showChevron={false}
          onPress={() => setTreeView(true)}
        />
      </GroupedSection>

      <ThreadSortGroup
        title={t('replyPreferences.replySorting', { defaultValue: 'Reply sorting' })}
      />
    </ScrollView>
  );
}
