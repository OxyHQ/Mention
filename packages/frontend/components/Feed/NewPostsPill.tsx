import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { useTranslation } from 'react-i18next';

/**
 * "N new posts", floating at the head of a timeline. The feed positions it; the
 * wrapper lets touches through everywhere but the button.
 */
export function NewPostsPill({
  count,
  overflow,
  onPress,
}: {
  count: number;
  overflow: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <View className="items-center" pointerEvents="box-none" accessibilityLiveRegion="polite">
      <Button size="sm" tone="accent" leadingIcon={RiArrowUpLine} onPress={onPress}>
        {overflow ? t('feed.newPostsOverflow', { count }) : t('feed.newPosts', { count })}
      </Button>
    </View>
  );
}
