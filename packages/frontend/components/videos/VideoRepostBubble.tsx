import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Text } from '@oxy.so/bloom/typography';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { AccountAvatar } from '@/components/ui/AccountAvatar';

import { Embed, Icon, VStack, defineTokens, toElement } from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexFFFFFF: '#FFFFFF' } });

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
    <View className="relative h-8 w-8" aria-hidden importantForAccessibility="no-hide-descendants">
      <AccountAvatar account={user} source={user.avatar} size={32} />
      <View className="absolute -bottom-0.5 -right-1 h-4 w-4 items-center justify-center rounded-full bg-violet-500">
        {toElement(Icon(RiRepeat2Line).size('10').foreground(appColors.color.hexFFFFFF))}
      </View>
    </View>
  );
  if (!onAddThought) return toElement(VStack(Embed(avatar)).frame({ width: '64' }).align('center'));
  const label = t('videos.addThought');
  return toElement(
    VStack(
      Embed(
        <View className="relative w-16 items-center rounded-2xl bg-neutral-100 px-2 py-2">
          <Text className="text-center text-[10px] leading-3 text-neutral-600">{label}</Text>
          <View className="absolute -bottom-1 h-2 w-2 rotate-45 bg-neutral-100" />
        </View>,
      ),
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
