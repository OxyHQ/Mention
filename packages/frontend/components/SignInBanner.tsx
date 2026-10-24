import { memo } from 'react';
import { View } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { InverseButton } from '@oxy.so/bloom/button';
import { Card, CardBody, CardDescription, CardTitle } from '@oxy.so/bloom/card';
import { PageFooter } from '@oxy.so/bloom/page-footer';

/**
 * The anonymous reader's invitation to sign in. `app/(app)/_layout.tsx` hands
 * it to the main panel's Bloom bottomBar slot, which places it and reserves its
 * measured height; Bloom's footer, accent card and its paired text colours
 * paint it the same on web and native.
 */
export const SignInBanner = memo(function SignInBanner() {
  const { signIn } = useAuth();
  const { t } = useTranslation();

  return (
    <PageFooter scrim="none" testID="sign-in-banner">
      <Card appearance="solid" tone="accent">
        <CardBody style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View className="flex-1">
            <CardTitle>{t('Don’t miss what’s happening')}</CardTitle>
            <CardDescription>{t('People on Mention are the first to know.')}</CardDescription>
          </View>
          <InverseButton size="sm" onPress={() => signIn().catch(() => {})}>
            {t('Sign In')}
          </InverseButton>
        </CardBody>
      </Card>
    </PageFooter>
  );
});
