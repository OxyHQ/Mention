import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';
import { Button } from '@/components/ui/Button';
import { Ionicons } from '@expo/vector-icons';

/**
 * Error Component
 * 
 * A full-screen error display component with optional retry and back buttons.
 * Reused from social-app and adapted for Mention's theme system.
 */

interface ErrorProps {
  title?: string;
  message?: string;
  onRetry?: () => void | Promise<void>;
  onGoBack?: () => void;
  hideBackButton?: boolean;
  sideBorders?: boolean;
  style?: ViewStyle;
}

export function Error({
  title = 'Something went wrong',
  message = 'An unexpected error occurred. Please try again.',
  onRetry,
  onGoBack,
  hideBackButton = false,
  sideBorders = true,
  style,
}: ErrorProps) {
  const router = useRouter();
  const theme = useTheme();

  const handleGoBack = () => {
    if (onGoBack) {
      onGoBack();
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/');
    }
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.background,
          paddingTop: 175,
          paddingBottom: 110,
        },
        style,
      ]}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <Ionicons
            name="alert-circle-outline"
            size={64}
            color={theme.colors.error}
          />
        </View>

        <ThemedText style={styles.title}>{title}</ThemedText>

        <ThemedText
          style={[
            styles.message,
            { color: theme.colors.textSecondary },
          ]}>
          {message}
        </ThemedText>
      </View>

      <View style={styles.actions}>
        {onRetry && (
          <Button
            variant="primary"
            onPress={onRetry}
            style={styles.button}>
            Retry
          </Button>
        )}

        {!hideBackButton && (
          <Button
            variant={onRetry ? 'secondary' : 'primary'}
            onPress={handleGoBack}
            style={styles.button}>
            {router.canGoBack() ? 'Go Back' : 'Go Home'}
          </Button>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
  },
  content: {
    width: '100%',
    alignItems: 'center',
    gap: 16,
    maxWidth: 450,
  },
  iconContainer: {
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
  },
  message: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 450,
  },
  actions: {
    width: '100%',
    maxWidth: 350,
    gap: 12,
  },
  button: {
    width: '100%',
    minHeight: 48,
  },
});

