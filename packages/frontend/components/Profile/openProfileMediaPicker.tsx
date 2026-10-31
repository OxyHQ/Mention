import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import type { ProfileMedia } from '@/stores/appearanceStore';
import { presentSheet } from '@/utils/sheet';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';

// The picker is shared by the profile and its editor, but neither needs it
// until the owner asks to edit their pinned media.
const MediaPickerSheet = lazy(() =>
  import('./MediaPickerSheet').then((module) => ({ default: module.MediaPickerSheet })),
);

function MediaPickerLoading() {
  const { t } = useTranslation();
  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Text className="text-foreground text-lg font-bold mb-3">{t('profile.media.title')}</Text>
      <FormSkeleton />
    </View>
  );
}

export function openProfileMediaPicker(currentMedia: ProfileMedia | null): void {
  void presentSheet((surface) => (
    <Suspense fallback={<MediaPickerLoading />}>
      <MediaPickerSheet currentMedia={currentMedia} onClose={() => surface.dismiss()} />
    </Suspense>
  ));
}
