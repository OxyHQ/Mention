import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Fab } from '@oxy.so/bloom/fab';
import { RiQuillPenLine } from '@oxy.so/bloom/icons/RiQuillPenLine';
import { TabPagerBottomBar, useTabPager } from '@oxy.so/bloom/tab-pager';
import { useAuth } from '@oxy.so/services/ui/client';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { useReselect } from '@/context/ScreenReselectContext';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';

/**
 * Bloom's bar over Mention's pages (`MentionTabPager`). Mention adds only what
 * is its own: the compose action, the account sheet on a long press of the
 * profile item, and "back to the top, then reload" on the item in front.
 */
export const BottomBar = () => {
  const { showBottomSheet } = useAuth();
  const { t } = useTranslation();
  const haptic = useHaptics();
  const reselect = useReselect();
  const { selectTab } = useTabPager();
  const onValueLongPress = useCallback(
    (value: string) => {
      if (value !== 'you') return;
      haptic('heavy');
      showBottomSheet?.('ManageAccount');
    },
    [haptic, showBottomSheet],
  );
  return (
    <TabPagerBottomBar
      onReselect={reselect}
      onValueLongPress={onValueLongPress}
      minimizeProgress={useBottomBarHidden()}
      action={
        <Fab
          icon={RiQuillPenLine}
          accessibilityLabel={t('sidebar.compose')}
          onPress={() => selectTab('write')}
        />
      }
    />
  );
};
