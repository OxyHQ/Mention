import { memo, useCallback } from 'react';
import { TouchableOpacity, View, type ViewStyle } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiFlowerLine } from '@oxy.so/bloom/icons/RiFlowerLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import type { ProfileMetaProps } from './types';

import { Embed, HStack, Icon, RawText, toElement } from '@oxy.so/bloom-language';

/** The meta row, as `flex-row flex-wrap mb-3 gap-x-4 gap-y-1` drew it. */
const META_ROW_STYLE: ViewStyle = {
  flexDirection: 'row',
  flexWrap: 'wrap',
  marginBottom: 12,
  columnGap: 16,
  rowGap: 4,
};
/** The join date, as `flex-row items-center gap-1` drew it. */
const JOINED_STYLE: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 4 };

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

  // React Native's views: the row wraps with a gap per axis, and the join date fades on press.
  return toElement(
    Embed((render) => (
      <View style={META_ROW_STYLE}>
        {hasLocation &&
          render(
            HStack(
              Icon(RiMapPinLine).size('sm').foreground('muted'),
              RawText(location).foreground('muted').font('md'),
            )
              .align('center')
              .spacing('xs'),
          )}
        {createdAt && (
          <TouchableOpacity
            style={JOINED_STYLE}
            onPress={openAbout}
            disabled={!aboutHref}
            activeOpacity={0.7}
          >
            {render(Icon(RiFlowerLine).size('sm').foreground('muted'))}
            {render(
              RawText(t('profile.joined'), ' ', formatJoinDate(createdAt))
                .foreground('muted')
                .font('md'),
            )}
            {aboutHref ? render(Icon(RiArrowRightSLine).size('sm').foreground('muted')) : null}
          </TouchableOpacity>
        )}
      </View>
    )),
  );
});
