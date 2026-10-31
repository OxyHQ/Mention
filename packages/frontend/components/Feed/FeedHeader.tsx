import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Platform } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from '@/lib/navigation/router';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { Button } from '@oxy.so/bloom/button';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiGalleryLine } from '@oxy.so/bloom/icons/RiGalleryLine';
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
export const FeedHeader = memo<FeedHeaderProps>(
  ({ showComposeButton, onComposePress, hideHeader, promptText }) => {
    const { t } = useTranslation();
    const router = useRouter();
    const { user } = useAuth();
    const theme = useTheme();
    const compose = useCallback(() => {
      if (onComposePress) onComposePress();
      else router.push('/compose');
    }, [onComposePress, router]);
    if (!showComposeButton || hideHeader || !user) return null;
    return (
      <View className="m-3 min-h-14 flex-row items-center gap-3 rounded-full bg-surface px-3 py-3">
        <PressableScale
          onPress={compose}
          accessibilityRole="button"
          accessibilityLabel={t('settings.quickActions.createPost')}
          className="min-w-0 flex-1 flex-row items-center gap-3"
        >
          <AccountAvatar
            account={user ?? undefined}
            source={user.avatar || undefined}
            size={32}
            variant={MEDIA_VARIANT_AVATAR}
          />
          <Text className="flex-1 text-base leading-5 text-muted-foreground">
            {promptText || t('compose.placeholder')}
          </Text>
        </PressableScale>
        {Platform.OS !== 'web' && (
          <Button
            appearance="plain"
            tone="neutral"
            size="xs"
            iconOnly
            icon={RiCameraLine}
            accessibilityLabel={t('camera.open')}
            onPress={() => router.navigate('/camera')}
          />
        )}
        <Button
          appearance="plain"
          tone="neutral"
          size="xs"
          iconOnly
          icon={<RiGalleryLine width={20} height={20} fill={theme.colors.textSecondary} />}
          accessibilityLabel={t('compose.toolbar.media')}
          onPress={() => router.push('/compose')}
        />
      </View>
    );
  },
);
FeedHeader.displayName = 'FeedHeader';
