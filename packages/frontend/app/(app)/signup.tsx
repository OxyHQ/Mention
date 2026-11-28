import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { Redirect, useGlobalSearchParams } from '@/lib/navigation/router';
import { SEO } from '@/components/SEO';
import { useAccountEntry } from '@/components/auth/useAccountEntry';
import { homeHrefPreservingEntry, signupPublicUrl, type EntryParams } from '@/lib/signupEntry';

/**
 * `/signup` — the shareable create-account URL for ads and landing links.
 *
 * The Oxy account dialog does not write the address bar, so a campaign has to
 * land on a real route. This screen opens that dialog on signup and leaves the
 * URL alone: Oxy records `utm_*` (and `fbclid` / `lang`) from the document that
 * loaded. Replacing the URL here would drop those params before that read.
 * A reader who already has a session is sent home with the same entry query.
 */
export default function SignupRoute() {
  const { t } = useTranslation();
  const { isAuthenticated, isAuthResolved } = useAuth();
  const { createAccount, signInAccount } = useAccountEntry();
  const params = useGlobalSearchParams();
  const back = useScreenBack();
  const opened = useRef(false);

  useEffect(() => {
    if (!isAuthResolved || isAuthenticated || opened.current) return;
    opened.current = true;
    createAccount();
  }, [isAuthResolved, isAuthenticated, createAccount]);

  if (!isAuthResolved) return null;

  if (isAuthenticated) {
    return <Redirect href={homeHrefPreservingEntry(params as EntryParams)} />;
  }

  return (
    <View className="flex-1">
      <SEO
        title={t('auth.gate.title')}
        description={t('auth.banner.subtitle')}
        url={signupPublicUrl()}
      />
      <PageHeader
        title={t('auth.banner.createAccount')}
        onBack={back}
        backLabel={t('common.back')}
      />
      <View
        className="flex-1 justify-center px-6 gap-4"
        style={{ maxWidth: 420, width: '100%', alignSelf: 'center' }}
      >
        <Text variant="title-2-bold" style={{ textAlign: 'center' }}>
          {t('auth.gate.title')}
        </Text>
        <Text variant="body-regular" style={{ textAlign: 'center' }}>
          {t('auth.banner.subtitle')}
        </Text>
        <Button
          testID="signup-create-account"
          appearance="solid"
          tone="accent"
          size="lg"
          fullWidth
          onPress={createAccount}
        >
          {t('auth.banner.createAccount')}
        </Button>
        <Button
          testID="signup-sign-in"
          appearance="plain"
          tone="neutral"
          size="lg"
          fullWidth
          onPress={signInAccount}
        >
          {t('auth.banner.signIn')}
        </Button>
      </View>
    </View>
  );
}
