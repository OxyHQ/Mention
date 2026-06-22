import React, { memo } from 'react';
import { View, Text, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxyhq/bloom/button';
import { PanelStickyFooter } from '@/components/shell/PanelChrome';

/**
 * Banner shown to signed-out users at the bottom of the middle column.
 *
 * Web: pinned to the bottom of the rounded center panel via
 * <PanelStickyFooter> (which owns the `position: sticky`, the
 * PANEL_BOTTOM_INSET gutter offset, the matching `rounded-b-[28px]` bottom
 * corners, and the z-index above the bleed mask). The banner's opaque
 * `bg-primary` surface + the footer's rounded bottom corners mask the feed's
 * bottom-edge bleed. The center column reserves bottom space (see
 * `app/(app)/_layout.tsx`) so the pinned banner never permanently hides the
 * last post.
 *
 * Native: <PanelStickyFooter> renders a bottom-anchored absolute overlay so the
 * banner floats over scrollable screen content without shifting layout.
 */
const IS_WEB = Platform.OS === 'web';

export const SignInBanner = memo(function SignInBanner() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const { t } = useTranslation();

  return (
    <PanelStickyFooter
      className="bg-primary"
      style={{ paddingBottom: IS_WEB ? 0 : insets.bottom }}
    >
      <View className="flex-row items-center justify-center px-4 py-3 gap-4 w-full">
        <View className="flex-1">
          <Text className="text-primary-foreground text-base font-bold">
            {t('Don’t miss what’s happening')}
          </Text>
          <Text className="text-primary-foreground/85 text-[13px] mt-0.5">
            {t('People on Mention are the first to know.')}
          </Text>
        </View>
        <Button
          variant="inverse"
          size="small"
          style={{ borderRadius: 100, paddingHorizontal: 20 }}
          onPress={() => signIn().catch(() => {})}
        >
          {t('Sign In')}
        </Button>
      </View>
    </PanelStickyFooter>
  );
});
