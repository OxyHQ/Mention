import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { RowIcon } from '@/components/settings/RowIcon';

import { ThreadSortGroup } from '@/components/settings/ThreadSortGroup';
import { useThreadPreferencesStore } from '@/hooks/useThreadPreferences';
import { Embed, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';

export default function ReplyPreferencesSheet() {
  const { t } = useTranslation();
  const treeView = useThreadPreferencesStore((state) => state.treeView);
  const setTreeView = useThreadPreferencesStore((state) => state.setTreeView);

  return (
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {toElement(
        LGroupedSection(
          LGroupedSectionItem(t('replyPreferences.linear', { defaultValue: 'Linear' }))
            .leadingView(Embed(<RowIcon icon={RiListUnordered} />))
            .trailing(Embed(<RadioIndicator selected={!treeView} />))
            .chevron(false)
            .onPress(() => setTreeView(false)),
          LGroupedSectionItem(t('replyPreferences.threaded', { defaultValue: 'Threaded' }))
            .leadingView(Embed(<RowIcon icon={RiNodeTree} />))
            .trailing(Embed(<RadioIndicator selected={treeView} />))
            .chevron(false)
            .onPress(() => setTreeView(true)),
        ).title(t('replyPreferences.showRepliesAs', { defaultValue: 'Show replies as' })),
      )}
      <ThreadSortGroup
        title={t('replyPreferences.replySorting', { defaultValue: 'Reply sorting' })}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Tailwind's `px-4` is the logical inline padding, as NativeWind wrote it.
  content: { paddingInline: 16, paddingTop: 8, paddingBottom: 32 },
});
