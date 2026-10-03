import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/common/EmptyState';
import { SEO } from '@/components/SEO';

/**
 * The app's one "this page does not exist" screen. Two routes reach it: the
 * `+not-found` catch-all, and `[username]`, which doubles as the catch-all for
 * unknown single-segment paths (`/whatever` is not `@`-prefixed, so it is not a
 * profile). Both draw this, so a broken link looks the same wherever it lands:
 * Bloom's empty state with its catalogue sticker, and one way out — home.
 */
export default function NotFoundScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <>
      {/* The server answers an unknown path with the app and a 200, so this
          screen is what says "not a page": indexed, it is a soft 404. */}
      <SEO
        title={t('seo.notFound.title')}
        description={t('seo.notFound.description')}
        robots="noindex,follow"
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
