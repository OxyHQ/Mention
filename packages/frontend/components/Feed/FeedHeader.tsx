import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from '@/lib/navigation/router';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { MediaAttachmentIcon } from '@oxy.so/bloom/icons/MediaAttachmentIcon';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { Button, Embed, HStack, Icon, Text as LText, toElement } from '@oxy.so/bloom-language';

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
    return toElement(
      HStack(
        HStack(
          Embed(
            <AccountAvatar
              account={user ?? undefined}
              source={user.avatar || undefined}
              size={32}
              variant={MEDIA_VARIANT_AVATAR}
            />,
          ),
          LText(promptText || t('compose.placeholder'))
            .flex('1')
            .font('16')
            .leading('20px')
            .foreground('muted'),
        )
          .frame({ minWidth: 'none' })
          .flex('1')
          .align('center')
          .spacing('md')
          .onPress(compose)
          .role('button')
          .label(t('settings.quickActions.createPost'))
          .pressScale(),
        Platform.OS !== 'web'
          ? Button(Icon(RiCameraLine))
              .style('plain')
              .tint('neutral')
              .size('xs')
              .shape('circle')
              .label(t('camera.open'))
              .onPress(() => router.navigate('/camera'))
          : null,
        Button(Icon(MediaAttachmentIcon).size('md').foreground('muted'))
          .style('plain')
          .tint('neutral')
          .size('xs')
          .shape('circle')
          .label(t('compose.toolbar.media'))
          .onPress(() => router.push('/compose')),
      )
        .padding('horizontal', 'md')
        .padding('vertical', 'md')
        .frame({ minHeight: '56' })
        .background('surface')
        .corner('infinite')
        .margin('all', 'md')
        .align('center')
        .spacing('md'),
    );
  },
);
FeedHeader.displayName = 'FeedHeader';
