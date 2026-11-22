import { tokens } from '@oxy.so/bloom/styles';
import { Platform, Pressable, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { usePodcastSave } from '@/hooks/usePodcastSave';

import { Icon, defineTokens, toElement } from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { white: 'white' } });

// The button stays React Native's Pressable: it announces its selected state, which
// the language has no modifier for. This draws its classes:
// `size-[30px] rounded-full items-center justify-center bg-white/20 active:bg-white/30`.
const saveButton: ViewStyle = {
  width: 30,
  height: 30,
  borderRadius: Platform.OS === 'web' ? 'calc(infinity * 1px)' : 9007199254740000,
  alignItems: 'center',
  justifyContent: 'center',
};
const REST = 'rgba(255,255,255,0.2)';
const PRESSED = 'rgba(255,255,255,0.3)';

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
  return (
    <Pressable
      onPress={toggleSave}
      hitSlop={tokens.hitSlop.md}
      accessibilityRole="button"
      accessibilityState={{ selected: isSaved }}
      accessibilityLabel={label}
      style={({ pressed }) => [saveButton, { backgroundColor: pressed ? PRESSED : REST }]}
    >
      {isSaved
        ? toElement(Icon(RiBookmarkFill).size('15').foreground(appColors.color.white))
        : toElement(Icon(RiBookmarkLine).size('15').foreground(appColors.color.white))}
    </Pressable>
  );
};
