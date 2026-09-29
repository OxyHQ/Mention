import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/common/EmptyState';
import { SEO } from '@/components/SEO';

/**
 * A route that does not exist. Drawn by the same Bloom empty state as every
 * other empty screen, with its catalogue sticker, and one way out: home.
 */
export default function NotFoundScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <>
      <SEO
        title={t('seo.notFound.title')}
        description={t('seo.notFound.description')}
      />
      <View className="flex-1 items-center justify-center">
        <EmptyState
          sticker="notFound"
          title={t('notFound.title', { defaultValue: 'This page does not exist' })}
          subtitle={t('notFound.subtitle', {
            defaultValue: 'The link may be broken, or the page may have moved.',
          })}
          action={{
            label: t('notFound.goHome', { defaultValue: 'Go to home' }),
            onPress: () => router.replace('/'),
          }}
        />
      </View>
    </>
  );
}
