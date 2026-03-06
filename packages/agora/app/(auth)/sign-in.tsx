import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';

import { useTheme } from '@/hooks/useTheme';
import { PrimaryButton } from '@/components/PrimaryButton';
import { AgoraActive } from '@mention/agora-shared';

export default function SignInScreen() {
  const theme = useTheme();
  const { isAuthenticated, signIn } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (isAuthenticated) {
      router.replace('/(app)/(tabs)');
    }
  }, [isAuthenticated]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <LinearGradient
        colors={[
          'transparent',
          theme.isDark ? 'rgba(255, 193, 7, 0.08)' : 'rgba(255, 193, 7, 0.1)',
          theme.isDark ? 'rgba(255, 193, 7, 0.2)' : 'rgba(255, 193, 7, 0.25)',
        ]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />

      <BlurView
        intensity={theme.isDark ? 60 : 40}
        tint={theme.isDark ? 'dark' : 'light'}
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />

      <View style={styles.content}>
        <AgoraActive size={64} color={theme.colors.primary} style={styles.icon} />
        <Text style={[styles.title, { color: theme.colors.primary }]}>
          Agora
        </Text>
        <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
          Live audio conversations with your community
        </Text>

        <PrimaryButton
          title="Sign In"
          onPress={() => signIn?.()}
          style={styles.button}
          textStyle={{ fontSize: 17 }}
        />
      </View>

      <Text style={[styles.byline, { color: theme.colors.textTertiary }]}>
        by Mention
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  icon: {
    marginBottom: 12,
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  description: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 21,
    opacity: 0.8,
  },
  button: {
    marginTop: 32,
    paddingHorizontal: 36,
    paddingVertical: 12,
    borderRadius: 22,
  },
  byline: {
    position: 'absolute',
    bottom: 48,
    fontSize: 14,
    fontWeight: '500',
  },
});
