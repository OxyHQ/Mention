import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { RiGitMergeLine } from '@oxy.so/bloom/icons/RiGitMergeLine';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { useTheme } from '@oxy.so/bloom/theme';

export interface ProfileTabBarRowProps {
  /** The strip itself — a routed one on web, a locally-driven one on native. */
  children: React.ReactNode;
  /** Shows the way in to the viewer's lanes. Own profile only. */
  showLanes: boolean;
}

/**
 * The row the profile's tab strip sits in.
 *
 * It carries the hairline rather than the strip does, so the border stays
 * continuous under the lanes button, which sits OUTSIDE the strip's own scroller
 * (a strip that scrolls must not scroll the button away). The button belongs
 * beside these tabs because a lane's whole effect is on which of them a post
 * lands on, and because the composer's lane icon was otherwise the only door to
 * the screen that manages them.
 *
 * Shared because the two platforms put different strips in it — see
 * `ProfileChromeFrame.tsx` — and the row around them is the part that is
 * genuinely the same.
 */
export function ProfileTabBarRow({ children, showLanes }: ProfileTabBarRowProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // Opaque in the column's own colour: the row pins over the scrolling profile
  // feed, so it matches the surface rather than naming one.
  const surfaceFill = useSurfaceFill();
  return (
    <View
      // The profile header owns the first sticky tier (top: 0). Tabs are the
      // second tier, so they remain available below the 56px header while the
      // document scrolls. z-40 keeps the opaque strip above ContentPanel's
      // bleed mask (z-30) without competing with its border frame (z-120).
      className="flex-row items-center border-b border-border web:sticky web:top-14 web:z-40"
      style={{ backgroundColor: surfaceFill }}
    >
      <View className="flex-1" style={{ minWidth: 0 }}>
        {children}
      </View>
      {showLanes ? (
        <TouchableOpacity
          onPress={() => router.push('/lanes')}
          activeOpacity={0.7}
          accessibilityRole="link"
          accessibilityLabel={t('lanes.title', { defaultValue: 'Lanes' })}
          className="px-3 py-2.5"
        >
          <RiGitMergeLine size="md" fill={colors.textSecondary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
