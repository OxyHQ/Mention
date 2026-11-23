import { memo, useCallback } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiFlowerLine } from '@oxy.so/bloom/icons/RiFlowerLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import type { ProfileMetaProps } from './types';

import { HStack, Icon, RawText, toElement } from '@oxy.so/bloom-language';

/**
 * Profile metadata component
 * Displays location and join date
 */
export const ProfileMeta = memo(function ProfileMeta({
  location,
  createdAt,
  aboutHref,
}: ProfileMetaProps) {
  const router = useRouter();
  const { t } = useTranslation();

  const hasLocation = Boolean(location);
  const hasJoinDate = Boolean(createdAt);

  const formatJoinDate = useCallback((date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
  }, []);

  const openAbout = useCallback(() => {
    if (aboutHref) router.push(aboutHref);
  }, [aboutHref, router]);

  if (!hasLocation && !hasJoinDate) {
    return null;
  }

  return toElement(
    HStack(
      hasLocation
        ? HStack(
            Icon(RiMapPinLine).size('sm').foreground('muted'),
            RawText(location).foreground('muted').font('md'),
          )
            .align('center')
            .spacing('xs')
        : null,
      createdAt
        ? HStack(
            Icon(RiFlowerLine).size('sm').foreground('muted'),
            RawText(t('profile.joined'), ' ', formatJoinDate(createdAt))
              .foreground('muted')
              .font('md'),
            aboutHref ? Icon(RiArrowRightSLine).size('sm').foreground('muted') : null,
          )
            .align('center')
            .spacing('xs')
            .disabled(!aboutHref)
            .onPress(openAbout)
            .pressFade('70')
        : null,
    )
      .wrap()
      .horizontalSpacing('lg')
      .verticalSpacing('xs')
      .margin('bottom', 'md'),
  );
});
