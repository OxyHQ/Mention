import { View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { AccountAvatar } from '@/components/ui/AccountAvatar';

import {
  Embed,
  Icon,
  Text as LText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

// Tailwind's violet-500, neutral-100 and neutral-600 as NativeWind painted them.
const appColors = defineTokens({
  color: {
    hexFFFFFF: '#FFFFFF',
    violet500: '#8e51ff',
    neutral100: '#f5f5f5',
    neutral600: '#525252',
  },
});
// The label's 12px line over its 10pt size (a leading is a ratio of the size).
const bubbleTokens = defineTokens({ leading: { label: 12 / 10 } });

// The avatar's box stays a view: it hides its avatar from assistive technology,
// which the language has no modifier for. This draws `relative h-8 w-8`.
const avatarBox: ViewStyle = { position: 'relative', width: 32, height: 32 };

interface VideoRepostBubbleProps {
  visible: boolean;
  /** Omit when quoting is unavailable; the repost identity remains noninteractive. */
  onAddThought?: () => void;
}

/** The active reel's repost acknowledgement, using the viewer's actual account. */
export function VideoRepostBubble({ visible, onAddThought }: VideoRepostBubbleProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  if (!visible || !user) return null;
  const avatar = (
    <View style={avatarBox} aria-hidden importantForAccessibility="no-hide-descendants">
      <AccountAvatar account={user} source={user.avatar} size={32} />
      {toElement(
        VStack(Icon(RiRepeat2Line).size('10').foreground(appColors.color.hexFFFFFF))
          .frame({ width: 'lg', height: 'lg' })
          .background(appColors.color.violet500)
          .corner('infinite')
          .position({ bottom: '-2xs', right: '-xs' })
          .align('center')
          .justify('center'),
      )}
    </View>
  );
  if (!onAddThought) return toElement(VStack(Embed(avatar)).frame({ width: '64' }).align('center'));
  const label = t('videos.addThought');
  return toElement(
    VStack(
      VStack(
        LText(label)
          .textAlign('center')
          .font('2xs')
          .leading(bubbleTokens.leading.label)
          .foreground(appColors.color.neutral600),
        VStack()
          .frame({ width: 'sm', height: 'sm' })
          .background(appColors.color.neutral100)
          .position({ bottom: '-xs' })
          .rotation('45'),
      )
        .padding('sm')
        .frame({ width: '64' })
        .background(appColors.color.neutral100)
        .corner('lg')
        .align('center'),
      Embed(avatar),
    )
      .frame({ width: '64' })
      .align('center')
      .spacing('xs')
      .role('button')
      .label(label)
      .onPress(onAddThought)
      .testID('video-repost-thought')
      .pressScale(),
  );
}
