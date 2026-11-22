import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import type { ProfileMedia } from '@/stores/appearanceStore';
import { presentSheet } from '@/utils/sheet';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

// The picker is shared by the profile and its editor, but neither needs it
// until the owner asks to edit their pinned media.
const MediaPickerSheet = lazy(() =>
  import('./MediaPickerSheet').then((module) => ({ default: module.MediaPickerSheet })),
);

function MediaPickerLoading() {
  const { t } = useTranslation();
  return toElement(
    VStack(
      RawText(t('profile.media.title'))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold')
        .margin('bottom', 'md'),
      Embed(<FormSkeleton />),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background'),
  );
}

export function openProfileMediaPicker(currentMedia: ProfileMedia | null): void {
  void presentSheet((surface) => (
    <Suspense fallback={<MediaPickerLoading />}>
      <MediaPickerSheet currentMedia={currentMedia} onClose={() => surface.dismiss()} />
    </Suspense>
  ));
}
