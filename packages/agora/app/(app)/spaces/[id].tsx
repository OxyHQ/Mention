import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLiveSpace, type Space } from '@mention/agora-shared';

import { useTheme } from '@/hooks/useTheme';
import { useSpace } from '@/hooks/useSpacesQuery';

export default function SpaceDetailScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { joinLiveSpace } = useLiveSpace();

  const { data: space = null, isLoading: loading } = useSpace(id as string);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!space) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>Space not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={[styles.backLink, { color: theme.colors.primary }]}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {space.title}
        </Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.content}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{space.title}</Text>
        {space.description && (
          <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
            {space.description}
          </Text>
        )}
        {space.topic && (
          <View style={[styles.topicBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <Text style={[styles.topicText, { color: theme.colors.textSecondary }]}>{space.topic}</Text>
          </View>
        )}

        <View style={styles.stats}>
          <View style={styles.statRow}>
            <Ionicons name="people" size={18} color={theme.colors.textSecondary} />
            <Text style={[styles.statText, { color: theme.colors.textSecondary }]}>
              {space.participants?.length || 0} participants
            </Text>
          </View>
          <View style={styles.statRow}>
            <Ionicons name="radio" size={18} color={space.status === 'live' ? '#FF4458' : theme.colors.textSecondary} />
            <Text style={[styles.statText, { color: space.status === 'live' ? '#FF4458' : theme.colors.textSecondary }]}>
              {space.status.toUpperCase()}
            </Text>
          </View>
        </View>

        {space.status === 'live' && (
          <TouchableOpacity
            style={[styles.joinButton, { backgroundColor: theme.colors.primary }]}
            onPress={() => {
              joinLiveSpace(space._id);
              router.back();
            }}
          >
            <Ionicons name="headset" size={20} color="#FFFFFF" />
            <Text style={styles.joinButtonText}>Join Space</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 16, fontWeight: '600', flex: 1, textAlign: 'center', marginHorizontal: 16 },
  content: { padding: 20, gap: 12 },
  title: { fontSize: 24, fontWeight: '800' },
  description: { fontSize: 15, lineHeight: 22 },
  topicBadge: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  topicText: { fontSize: 13, fontWeight: '500' },
  stats: { gap: 8, marginTop: 8 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statText: { fontSize: 14 },
  joinButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderRadius: 28,
    marginTop: 16,
  },
  joinButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  errorText: { fontSize: 16, marginBottom: 12 },
  backLink: { fontSize: 15, fontWeight: '600' },
});
