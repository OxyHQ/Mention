import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMediaQuery } from 'react-responsive';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';

import { LogoIcon } from '@/assets/logo';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/hooks/useTheme';

export default function AuthScreen() {
  const theme = useTheme();
  const { signIn } = useAuth();
  const { t } = useTranslation();
  const isDesktop = useMediaQuery({ minWidth: 768 });

  if (isDesktop) {
    return (
      <View className="flex-1 flex-row bg-background">
        <View className="flex-1 justify-center items-center p-12 bg-primary">
          <View className="max-w-[400px] items-start gap-4">
            <LogoIcon size={56} color="#fff" />
            <Text className="text-[42px] font-bold text-white mt-2">Mention</Text>
            <Text className="text-xl text-white/85 leading-7">
              {t('See what\u2019s happening in the world right now.')}
            </Text>
          </View>
        </View>
        <View className="flex-1 justify-center items-center p-12">
          <View className="w-full max-w-[360px] gap-6">
            <Text className="text-2xl font-bold text-foreground">
              {t('Log into Mention')}
            </Text>
            <Button
              variant="primary"
              size="large"
              style={styles.signInButton}
              onPress={() => signIn().catch(() => {})}
            >
              {t('Sign In with Oxy')}
            </Button>
          </View>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 justify-center items-center p-6 bg-background">
      <View className="flex-1 justify-center items-center gap-4">
        <LogoIcon size={48} color={theme.colors.primary} />
        <Text className="text-[28px] font-bold mt-2 text-foreground">
          Mention
        </Text>
        <Text className="text-base text-center max-w-[280px] leading-[22px] text-muted-foreground">
          {t('See what\u2019s happening in the world right now.')}
        </Text>
      </View>
      <View className="w-full max-w-[320px] pb-8">
        <Button
          variant="primary"
          size="large"
          style={styles.signInButton}
          onPress={() => signIn().catch(() => {})}
        >
          {t('Sign In with Oxy')}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  signInButton: {
    width: '100%',
    borderRadius: 100,
    ...Platform.select({
      web: { cursor: 'pointer' },
    }),
  },
});
