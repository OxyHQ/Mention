import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';

import { LogoIcon } from '@/assets/logo';
import { useWindowBreakpoint } from '@oxy.so/bloom/hooks';
import { createTokenStyles, useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

export default function AuthScreen() {
  const { signIn } = useAuth();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const ink = useInkStyles();
  const insets = useSafeAreaInsets();
  const breakpoint = useWindowBreakpoint();
  const wide = breakpoint !== 'base' && breakpoint !== 'sm';

  // Both layouts render always; the `md` breakpoint (768px) toggles which is
  // displayed: the desktop split-screen at >=md, the stacked mobile layout
  // below it. The window's breakpoint tier is Bloom's own (re-rendering only
  // when the window crosses one); the mobile layout's padding adds the safe
  // area's insets, which no language modifier takes.
  return (
    <>
      {/* Desktop split-screen (>= md) */}
      <View style={[styles.desktop, wide && styles.desktopShown]}>
        {toElement(
          VStack(
            VStack(
              Embed(<LogoIcon size={56} color="#fff" />),
              Embed(<Text style={styles.wordmark}>Mention</Text>),
              Embed(<Text style={styles.tagline}>{t('auth.signIn.subtitle')}</Text>),
            )
              .frame({ maxWidth: '400' })
              .align('start')
              .spacing('lg'),
          )
            .padding('all', '48')
            .background('primary')
            .flex('1')
            .justify('center')
            .align('center'),
        )}
        {toElement(
          VStack(
            VStack(
              RawText(t('auth.signIn.title'))
                .font('24')
                .leading('32px')
                .weight('bold')
                .foreground('foreground'),
              Embed(
                <Button
                  appearance="solid"
                  tone="accent"
                  size="lg"
                  style={styles.signInButton}
                  onPress={() => signIn().catch(() => {})}
                >
                  {t('auth.signIn.withOxy')}
                </Button>,
              ),
            )
              .frame({ width: 'full', maxWidth: '360' })
              .spacing('2xl'),
          )
            .padding('all', '48')
            .flex('1')
            .justify('center')
            .align('center'),
        )}
      </View>
      {/* Stacked mobile layout (< md) */}
      <View
        style={[
          styles.mobile,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
          wide && styles.hidden,
        ]}
      >
        {toElement(
          VStack(
            Embed(<LogoIcon size={48} color={colors.primary} />),
            Embed(<Text style={[styles.mobileWordmark, ink.foreground]}>Mention</Text>),
            RawText(t('auth.signIn.subtitle'))
              .frame({ maxWidth: '280' })
              .font('16')
              .textAlign('center')
              .leading('22px')
              .foreground('muted'),
          )
            .flex('1')
            .justify('center')
            .align('center')
            .spacing('lg'),
        )}
        {toElement(
          VStack(
            Embed(
              <Button
                appearance="solid"
                tone="accent"
                size="lg"
                style={styles.signInButton}
                onPress={() => signIn().catch(() => {})}
              >
                {t('auth.signIn.withOxy')}
              </Button>,
            ),
          )
            .padding('bottom', '3xl')
            .frame({ width: 'full', maxWidth: '320' }),
        )}
      </View>
    </>
  );
}

const useInkStyles = createTokenStyles((t) => ({ foreground: { color: t.foreground } }));

const styles = StyleSheet.create({
  signInButton: {
    width: '100%',
  },
  // Tailwind's `flex-1` (grow, shrink, a 0% basis).
  desktop: { display: 'none', flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  desktopShown: { display: 'flex', flexDirection: 'row' },
  mobile: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  hidden: { display: 'none' },
  // The wordmarks' sizes (42px, 28px) are no type step or font token.
  wordmark: { fontSize: 42, fontWeight: '700', color: '#fff', marginTop: 8 },
  mobileWordmark: { fontSize: 28, fontWeight: '700', marginTop: 8 },
  // White at 85%: NativeWind's 8-bit alpha natively, the colour mix on the web.
  tagline: {
    fontSize: 20,
    lineHeight: 28,
    color: Platform.OS === 'web' ? 'rgba(255, 255, 255, 0.85)' : '#ffffffd9',
  },
});
