import React, { memo } from 'react';
import { View, Text, Platform, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxyhq/bloom/button';

/**
 * Banner shown to signed-out users at the bottom of the middle column.
 *
 * Web: `position: sticky; bottom: 0` so it PINS to the bottom of the viewport
 * while the feed scrolls behind it (the document is the scroller). It stays
 * INSIDE the rounded center panel — it is a flex child of that panel, so it
 * inherits the panel's width/gutter and rounds its OWN bottom corners
 * (`md:rounded-b-[28px]`) to match the panel's `rounded-[28px]`. Its opaque
 * `bg-primary` surface + the rounded bottom corners THEMSELVES mask the feed's
 * bottom-edge bleed, so it must paint ABOVE the bleed-mask overlay (mask z-30):
 * `z-[110]` keeps the 40px gutter ring from clipping the banner's bottom edge.
 * `flexShrink: 0` keeps it from collapsing. The center column reserves bottom
 * space (see `app/(app)/_layout.tsx`) so the pinned banner never permanently
 * hides the last post.
 *
 * Native: rendered as an absolute overlay so it floats over scrollable
 * screen content without shifting layout (keeps the high z-index there).
 */
const IS_WEB = Platform.OS === 'web';

// RN's ViewStyle type does not model CSS `position: 'sticky'`; on web
// react-native-web forwards it to the DOM as real CSS. Cast once here (mirrors
// SideBar's `webStickyContainerStyle` pattern) — not `as any`.
//
// WEB `bottom: 8` (NOT 0): the center panel sits in an 8px gutter (`md:p-2`),
// and the bleed-mask's 40px gutter box-shadow covers the bottom 8px of the
// viewport. Pinning the banner at bottom:0 would put its bottom edge inside that
// shadow band → clipped. bottom:8 seats it just above the band, fully inside the
// rounded panel, leaving the matching gutter clearance below the rounded corner.
const containerStyle: ViewStyle = (IS_WEB
  ? { position: 'sticky', bottom: 8, flexShrink: 0 }
  : { position: 'absolute', bottom: 0, left: 0, right: 0 }) as ViewStyle;

export const SignInBanner = memo(function SignInBanner() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const { t } = useTranslation();

  return (
    <View
      className={IS_WEB ? 'bg-primary w-full z-[110] md:rounded-b-[28px]' : 'bg-primary z-[999] w-full'}
      style={[
        containerStyle,
        { paddingBottom: IS_WEB ? 0 : insets.bottom },
      ]}
    >
      <View className="flex-row items-center justify-center px-4 py-3 gap-4 w-full">
        <View className="flex-1">
          <Text className="text-primary-foreground text-base font-bold">
            {t('Don\u2019t miss what\u2019s happening')}
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
    </View>
  );
});
