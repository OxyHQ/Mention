import React, { memo, useCallback } from 'react';
import { View, Platform } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { router } from 'expo-router';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { Text } from '@oxy.so/bloom/typography';

interface FeedHeaderProps {
  showComposeButton?: boolean;
  onComposePress?: () => void;
  hideHeader?: boolean;
  promptText?: string;
}

/** 56px composer plus its 12px outer margins; reply footers reserve this height. */
export const FEED_COMPOSER_PROMPT_HEIGHT = 80;

/** Social template composer, with Mention's real account and camera destinations. */
export const FeedHeader = memo<FeedHeaderProps>(({ showComposeButton, onComposePress, hideHeader, promptText }) => {
  const { user } = useAuth();
  const compose = useCallback(() => {
    if (onComposePress) onComposePress();
    else router.push('/compose');
  }, [onComposePress]);
  if (!showComposeButton || hideHeader || !user) return null;
  return <View className="m-3 min-h-14 flex-row items-center gap-3 rounded-full bg-surface px-3 py-3">
    <PressableScale onPress={compose} accessibilityRole="button" accessibilityLabel="Create a post"
      className="min-w-0 flex-1 flex-row items-center gap-3">
      <Avatar source={user.avatar || undefined} size={32} variant={MEDIA_VARIANT_AVATAR} />
      <Text className="flex-1 text-base leading-5 text-muted-foreground">{promptText || "What's up?"}</Text>
    </PressableScale>
    {Platform.OS !== 'web' && <Button appearance="plain" tone="neutral" size="xs" iconOnly icon={RiCameraLine}
      accessibilityLabel="Open camera" onPress={() => router.navigate('/camera')} />}
    <Button appearance="plain" tone="neutral" size="xs" iconOnly icon={RiImageLine}
      accessibilityLabel="Add image" onPress={() => router.push('/compose')} />
  </View>;
});
FeedHeader.displayName = 'FeedHeader';
