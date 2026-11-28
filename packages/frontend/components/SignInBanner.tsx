import { memo, useContext } from 'react';
import { View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { EdgeScrim } from '@oxy.so/bloom/page-header';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useAccountEntry } from '@/components/auth/useAccountEntry';

/** Height of the fade that rises above the solid block. Matches Bloom's BottomPromo. */
const FADE_HEIGHT = 96;
const SIDE_PADDING = 16;
const MIN_BOTTOM_PADDING = 20;

/**
 * The anonymous reader's invitation. `app/(app)/_layout.tsx` hands it to the
 * main panel's bottomBar slot, which places it and reserves its measured height.
 *
 * Bloom's BottomPromo has one action. This draws the same fade and solid block
 * with Create account as the primary action and Sign in beside it, so a
 * logged-out reader is not offered only sign-in.
 */
export const SignInBanner = memo(function SignInBanner() {
  const { t } = useTranslation();
  const theme = useTheme();
  const fill = useSurfaceFill() ?? theme.colors.background;
  const safeAreaBottom = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  const { createAccount, signInAccount } = useAccountEntry();

  return (
    <View testID="sign-in-banner">
      <View pointerEvents="none" style={{ height: FADE_HEIGHT }}>
        <EdgeScrim edge="bottom" color={fill} />
      </View>
      <View
        style={{
          backgroundColor: fill,
          gap: 16,
          paddingHorizontal: SIDE_PADDING,
          paddingBottom: Math.max(MIN_BOTTOM_PADDING, safeAreaBottom),
        }}
      >
        <View style={{ gap: 4 }}>
          <Text variant="title-2-bold" style={{ textAlign: 'center', color: theme.colors.text }}>
            {t('auth.banner.title')}
          </Text>
          <Text
            variant="body-regular"
            style={{ textAlign: 'center', color: theme.colors.textSecondary }}
          >
            {t('auth.banner.subtitle')}
          </Text>
        </View>
        <View style={{ gap: 8 }}>
          <Button
            testID="sign-in-banner-create-account"
            appearance="solid"
            tone="neutral"
            inverted
            fullWidth
            size="lg"
            onPress={createAccount}
          >
            {t('auth.banner.createAccount')}
          </Button>
          <Button
            testID="sign-in-banner-sign-in"
            appearance="plain"
            tone="neutral"
            fullWidth
            size="lg"
            onPress={signInAccount}
          >
            {t('auth.banner.signIn')}
          </Button>
        </View>
      </View>
    </View>
  );
});
