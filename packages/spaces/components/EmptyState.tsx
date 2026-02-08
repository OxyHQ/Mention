import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import LottieView from 'lottie-react-native';

import { useTheme } from '@/hooks/useTheme';

interface EmptyStateProps {
  animation: any;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}

export function EmptyState({ animation, title, subtitle, children }: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <View style={styles.lottieContainer}>
        <LottieView
          source={animation}
          autoPlay
          loop
          style={styles.lottie}
        />
      </View>
      <Text style={[styles.title, { color: theme.colors.text }]}>{title}</Text>
      <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>{subtitle}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 12,
  },
  lottieContainer: { width: 120, height: 120 },
  lottie: { width: 120, height: 120 },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
});
