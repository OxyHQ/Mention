import { View, Text, StyleSheet } from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';

import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

export default function AuthScreen() {
  const { signIn } = useAuth();
  const { t } = useTranslation();
  const { colors } = useTheme();

  // Both layouts render always; NativeWind's `md` breakpoint (768px) toggles
  // which is displayed \u2014 the desktop split-screen at >=md, the stacked mobile
  // layout below it. Pure class-driven responsiveness, no JS media-query hook.
  return (
    <>
      {/* Desktop split-screen (>= md) */}
      <View className="hidden md:flex flex-1 md:flex-row">
        {toElement(
          VStack(
            VStack(
              Embed(<LogoIcon size={56} color="#fff" />),
              Embed(<Text className="text-[42px] font-bold text-white mt-2">Mention</Text>),
              Embed(
                <Text className="text-xl text-white/85 leading-7">
                  {t('auth.signIn.subtitle')}
                </Text>,
              ),
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
      <View className="flex md:hidden flex-1 justify-center items-center px-6 pt-safe-offset-6 pb-safe-offset-6">
        {toElement(
          VStack(
            Embed(<LogoIcon size={48} color={colors.primary} />),
            Embed(<Text className="text-[28px] font-bold mt-2 text-foreground">Mention</Text>),
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

const styles = StyleSheet.create({
  signInButton: {
    width: '100%',
  },
});
