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
      <View style={[styles.desktopContainer, { backgroundColor: theme.colors.background }]}>
        <View style={[styles.heroPanel, { backgroundColor: theme.colors.primary }]}>
          <View style={styles.heroContent}>
            <LogoIcon size={56} color="#fff" />
            <Text style={styles.heroTitle}>Mention</Text>
            <Text style={styles.heroTagline}>
              {t('See what\u2019s happening in the world right now.')}
            </Text>
          </View>
        </View>
        <View style={styles.formPanel}>
          <View style={styles.formContent}>
            <Text style={[styles.formTitle, { color: theme.colors.text }]}>
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
    <SafeAreaView style={[styles.mobileContainer, { backgroundColor: theme.colors.background }]}>
      <View style={styles.mobileContent}>
        <LogoIcon size={48} color={theme.colors.primary} />
        <Text style={[styles.mobileTitle, { color: theme.colors.text }]}>
          Mention
        </Text>
        <Text style={[styles.mobileTagline, { color: theme.colors.textSecondary }]}>
          {t('See what\u2019s happening in the world right now.')}
        </Text>
      </View>
      <View style={styles.mobileActions}>
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
  // Desktop: two-column layout
  desktopContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  heroPanel: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 48,
  },
  heroContent: {
    maxWidth: 400,
    alignItems: 'flex-start',
    gap: 16,
  },
  heroTitle: {
    fontSize: 42,
    fontWeight: 'bold',
    color: '#fff',
    marginTop: 8,
  },
  heroTagline: {
    fontSize: 20,
    color: 'rgba(255, 255, 255, 0.85)',
    lineHeight: 28,
  },
  formPanel: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 48,
  },
  formContent: {
    width: '100%',
    maxWidth: 360,
    gap: 24,
  },
  formTitle: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  signInButton: {
    width: '100%',
    borderRadius: 100,
    ...Platform.select({
      web: { cursor: 'pointer' },
    }),
  },

  // Mobile: single column
  mobileContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  mobileContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  mobileTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    marginTop: 8,
  },
  mobileTagline: {
    fontSize: 16,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 22,
  },
  mobileActions: {
    width: '100%',
    maxWidth: 320,
    paddingBottom: 32,
  },
});
