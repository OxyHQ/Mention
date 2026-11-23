import { useTranslation } from 'react-i18next';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { usePodcastSave } from '@/hooks/usePodcastSave';

import { Icon, VStack, defineTokens, toElement } from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { white: 'white' } });

/**
 * The podcast card's save button: subscribes the viewer to the show in their
 * Syra library. Its own component so the subscription query only mounts where
 * a save button is actually shown.
 */
export const PodcastSaveButton = ({ podcastId }: { podcastId: string }) => {
  const { t } = useTranslation();
  const { isSaved, toggleSave } = usePodcastSave(podcastId);
  const label = isSaved
    ? t('podcast.card.unsave', { defaultValue: 'Remove from saved' })
    : t('podcast.card.save', { defaultValue: 'Save' });
  return toElement(
    VStack(
      isSaved
        ? Icon(RiBookmarkFill).size('15').foreground(appColors.color.white)
        : Icon(RiBookmarkLine).size('15').foreground(appColors.color.white),
    )
      .frame({ width: '30', height: '30' })
      .background('white/20')
      .corner('infinite')
      .align('center')
      .justify('center')
      .when('pressed', (v) => v.background('white/30'))
      .onPress(toggleSave)
      .hitSlop('md')
      .role('button')
      .accessibilityState({ selected: isSaved })
      .label(label),
  );
};
