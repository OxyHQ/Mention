import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';

import { LogoIcon } from '@/assets/logo';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/hooks/useTheme';

export default function AuthScreen() {
  const theme = useTheme();
  const { showBottomSheet } = useAuth();
  const { t } = useTranslation();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.content}>
        <LogoIcon size={48} color={theme.colors.primary} />
        <Text style={[styles.title, { color: theme.colors.text }]}>
          Mention
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          {t('See what\u2019s happening in the world right now.')}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          variant="primary"
          size="large"
          style={styles.button}
          onPress={() => showBottomSheet?.('SignIn')}
        >
          {t('Sign In')}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginTop: 8,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 22,
  },
  actions: {
    width: '100%',
    maxWidth: 320,
    paddingBottom: 32,
  },
  button: {
    width: '100%',
    borderRadius: 100,
    ...Platform.select({
      web: { cursor: 'pointer' },
    }),
  },
});
