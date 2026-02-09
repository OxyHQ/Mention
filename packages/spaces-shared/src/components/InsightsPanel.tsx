import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import type { Space, SpaceParticipant } from '../types';

interface InsightsPanelProps {
  space: Space | null;
  participants: SpaceParticipant[];
  theme: any;
  onClose: () => void;
}

function formatDuration(startedAt: string | undefined): string {
  if (!startedAt) return '—';
  const diffMs = Date.now() - new Date(startedAt).getTime();
  if (diffMs < 0) return '—';
  const totalSecs = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function InsightsPanel({ space, participants, theme, onClose }: InsightsPanelProps) {
  const speakers = participants.filter((p) => p.role === 'host' || p.role === 'speaker');
  const listeners = participants.filter((p) => p.role === 'listener');

  const duration = useMemo(() => formatDuration(space?.startedAt), [space?.startedAt]);

  const stats = [
    {
      icon: 'account-group' as const,
      label: 'Current',
      value: participants.length.toString(),
      color: theme.colors.primary,
    },
    {
      icon: 'chart-line' as const,
      label: 'Peak',
      value: space?.stats?.peakListeners?.toString() ?? '—',
      color: '#FF9800',
    },
    {
      icon: 'account-plus' as const,
      label: 'Total Joined',
      value: space?.stats?.totalJoined?.toString() ?? '—',
      color: '#4CAF50',
    },
    {
      icon: 'clock-outline' as const,
      label: 'Duration',
      value: duration,
      color: '#9C27B0',
    },
  ];

  return (
    <View style={styles.container}>
      <View style={[styles.header, { borderBottomColor: `${theme.colors.border}80` }]}>
        <TouchableOpacity onPress={onClose} style={styles.backButton}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Insights</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.statsGrid}>
          {stats.map((stat) => (
            <View
              key={stat.label}
              style={[styles.statCard, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}
            >
              <View style={[styles.statIconCircle, { backgroundColor: `${stat.color}1A` }]}>
                <MaterialCommunityIcons name={stat.icon} size={20} color={stat.color} />
              </View>
              <Text style={[styles.statValue, { color: theme.colors.text }]}>{stat.value}</Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>{stat.label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.breakdownSection}>
          <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
            Breakdown
          </Text>

          <View style={[styles.breakdownRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
            <View style={[styles.breakdownIcon, { backgroundColor: `${theme.colors.primary}1A` }]}>
              <MaterialCommunityIcons name="microphone" size={18} color={theme.colors.primary} />
            </View>
            <Text style={[styles.breakdownLabel, { color: theme.colors.text }]}>Speakers</Text>
            <Text style={[styles.breakdownValue, { color: theme.colors.text }]}>{speakers.length}</Text>
          </View>

          <View style={[styles.breakdownRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
            <View style={[styles.breakdownIcon, { backgroundColor: '#FF98001A' }]}>
              <MaterialCommunityIcons name="headphones" size={18} color="#FF9800" />
            </View>
            <Text style={[styles.breakdownLabel, { color: theme.colors.text }]}>Listeners</Text>
            <Text style={[styles.breakdownValue, { color: theme.colors.text }]}>{listeners.length}</Text>
          </View>
        </View>

        {space?.tags && space.tags.length > 0 && (
          <View style={styles.tagsSection}>
            <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>Tags</Text>
            <View style={styles.tagsRow}>
              {space.tags.map((tag) => (
                <View key={tag} style={[styles.tagChip, { backgroundColor: `${theme.colors.primary}1A` }]}>
                  <Text style={[styles.tagText, { color: theme.colors.primary }]}>#{tag}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {space?.startedAt && (
          <View style={styles.metaSection}>
            <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>Details</Text>
            <View style={[styles.metaRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
              <Text style={[styles.metaLabel, { color: theme.colors.textSecondary }]}>Started</Text>
              <Text style={[styles.metaValue, { color: theme.colors.text }]}>
                {new Date(space.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
            {space.topic && (
              <View style={[styles.metaRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
                <Text style={[styles.metaLabel, { color: theme.colors.textSecondary }]}>Topic</Text>
                <Text style={[styles.metaValue, { color: theme.colors.text }]} numberOfLines={1}>{space.topic}</Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: { width: 40, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  scrollContent: { padding: 16, paddingBottom: 32 },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statCard: {
    width: '47%',
    flexGrow: 1,
    alignItems: 'center',
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  statIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 12, fontWeight: '500' },
  breakdownSection: { marginTop: 20, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  breakdownIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  breakdownLabel: { flex: 1, fontSize: 15, fontWeight: '500' },
  breakdownValue: { fontSize: 17, fontWeight: '700' },
  tagsSection: { marginTop: 20 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tagChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  tagText: { fontSize: 13, fontWeight: '600' },
  metaSection: { marginTop: 20, gap: 8 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  metaLabel: { fontSize: 14, fontWeight: '500' },
  metaValue: { fontSize: 14, fontWeight: '600' },
});
