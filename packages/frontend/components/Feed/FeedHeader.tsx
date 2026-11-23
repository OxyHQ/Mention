import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from '@/lib/navigation/router';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { Button } from '@oxy.so/bloom/button';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { MediaAttachmentIcon } from '@oxy.so/bloom/icons/MediaAttachmentIcon';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { Text } from '@oxy.so/bloom/typography';
import { Surface } from '@oxy.so/bloom/surface';

/** A radius past half the height: the lens and the paint clamp it to a capsule. */
const CAPSULE = 9999;

interface FeedHeaderProps {
  showComposeButton?: boolean;
  onComposePress?: () => void;
  hideHeader?: boolean;
  promptText?: string;
}

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
      // On the glass the bar and the header controls are on: Bloom's lens material, a capsule.
      <Surface
        material="lens"
        radius={CAPSULE}
        className="m-3 min-h-14 flex-row items-center gap-3 self-stretch px-3 py-3"
      >
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
          icon={<MediaAttachmentIcon width={20} height={20} fill={theme.colors.textSecondary} />}
          accessibilityLabel={t('compose.toolbar.media')}
          onPress={() => router.push('/compose')}
        />
      </Surface>
    );
  },
);
FeedHeader.displayName = 'FeedHeader';
