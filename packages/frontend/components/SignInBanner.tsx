import { memo } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { BottomPromo } from '@oxy.so/bloom/bottom-promo';

/**
 * The anonymous reader's invitation to sign in. `app/(app)/_layout.tsx` hands
 * it to the main panel's bottomBar slot, which places it and reserves its
 * measured height; Bloom's BottomPromo draws the fade, the centred copy and the
 * full-width action.
 */
export const SignInBanner = memo(function SignInBanner() {
  const { signIn } = useAuth();
  const { t } = useTranslation();

  return (
    <BottomPromo
      testID="sign-in-banner"
      title={t('auth.banner.title')}
      description={t('auth.banner.subtitle')}
      actionLabel={t('auth.banner.signIn')}
      onAction={() => signIn().catch(() => {})}
    />
  );
});
