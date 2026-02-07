import React, { memo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/Button';
import { useTheme } from '@/hooks/useTheme';

export const SignInBanner = memo(function SignInBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { showBottomSheet } = useAuth();
  const { t } = useTranslation();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.primary,
          paddingBottom: Platform.OS === 'web' ? 0 : insets.bottom,
        },
      ]}
    >
      <View style={styles.content}>
        <View style={styles.textContainer}>
          <Text style={styles.title}>{t('Don\u2019t miss what\u2019s happening')}</Text>
          <Text style={styles.subtitle}>
            {t('People on Mention are the first to know.')}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="small"
            style={styles.signInButton}
            textStyle={styles.signInButtonText}
            onPress={() => showBottomSheet?.('SignIn')}
          >
            {t('Sign In')}
          </Button>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    ...Platform.select({
      web: {
        position: 'fixed' as any,
        bottom: 0,
        left: 0,
        right: 0,
      },
      default: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
      },
    }),
    zIndex: 999,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 16,
    maxWidth: 1200,
    marginHorizontal: 'auto',
    width: '100%',
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fff',
  },
  subtitle: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.85)',
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  signInButton: {
    borderColor: '#fff',
    borderRadius: 100,
    paddingHorizontal: 16,
  },
  signInButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
});
