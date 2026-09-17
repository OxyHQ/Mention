import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@oxy.so/bloom/typography';

import { SEO } from '@/components/SEO';

export default function NotFoundScreen() {
  const { t } = useTranslation();

  return (
    <>
      <SEO
        title={t('seo.notFound.title')}
        description={t('seo.notFound.description')}
      />
      <View style={styles.container}>
        <Text className="text-[32px] leading-8 font-bold text-foreground">This screen does not exist.</Text>
        <Link href="/" style={styles.link}>
          <Text className="text-base leading-[30px] text-primary">Go to home screen!</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
});
