import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';

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
      <View style={styles.content}>
        <Text style={[styles.title, { color: theme.colors.primary }]}>
          Spaces
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          by Mention
        </Text>
        <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
          Live audio conversations with your community
        </Text>

        <TouchableOpacity
          style={[styles.signInButton, { backgroundColor: theme.colors.primary }]}
          onPress={() => signIn?.()}
        >
          <Text style={styles.signInButtonText}>Sign In</Text>
        </TouchableOpacity>
      </View>
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
  title: {
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: -1,
  },
  subtitle: {
    fontSize: 18,
    fontWeight: '500',
    marginTop: 4,
  },
  description: {
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 22,
  },
  signInButton: {
    marginTop: 40,
    paddingHorizontal: 48,
    paddingVertical: 16,
    borderRadius: 28,
  },
  signInButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
});
