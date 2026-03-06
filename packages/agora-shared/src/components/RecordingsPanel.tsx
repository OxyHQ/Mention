import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { PanelHeader } from './PanelHeader';
import { useAgoraConfig } from '../context/AgoraConfigContext';
import type { Recording, AgoraTheme } from '../types';

interface RecordingsPanelProps {
  roomId: string;
  isHost: boolean;
  theme: AgoraTheme;
  onClose: () => void;
  onPlay?: (playbackUrl: string, recording: Recording) => void;
}

function formatDurationMs(ms: number | null | undefined): string {
  if (!ms) return '—';
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function RecordingsPanel({ roomId, isHost, theme, onClose, onPlay }: RecordingsPanelProps) {
  const { agoraService, toast } = useAgoraConfig();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    loadRecordings();
  }, [roomId]);

  const loadRecordings = async () => {
    setLoading(true);
    const data = await agoraService.getRoomRecordings(roomId);
    setRecordings(data);
    setLoading(false);
  };

  const handlePlay = async (recording: Recording) => {
    setPlayingId(recording._id);
    try {
      const result = await agoraService.getRecording(recording._id);
      if (result?.playbackUrl) {
        onPlay?.(result.playbackUrl, recording);
      } else {
        toast.error('Failed to load playback URL');
      }
    } catch {
      toast.error('Failed to load recording');
    } finally {
      setPlayingId(null);
    }
  };

  const handleToggleAccess = async (recording: Recording) => {
    const newAccess = recording.access === 'public' ? 'participants' as const : 'public' as const;
    const success = await agoraService.updateRecordingAccess(recording._id, newAccess);
    if (success) {
      setRecordings((prev) =>
        prev.map((r) => r._id === recording._id ? { ...r, access: newAccess } : r)
      );
      toast.success(`Recording is now ${newAccess}`);
    } else {
      toast.error('Failed to update access');
    }
  };

  const handleDelete = async (recording: Recording) => {
    const success = await agoraService.deleteRecording(recording._id);
    if (success) {
      setRecordings((prev) => prev.filter((r) => r._id !== recording._id));
      toast.success('Recording deleted');
    } else {
      toast.error('Failed to delete recording');
    }
  };

  return (
    <View style={styles.container}>
      <PanelHeader title="Recordings" theme={theme} onBack={onClose} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : recordings.length === 0 ? (
          <View style={styles.centered}>
            <MaterialCommunityIcons name="record-circle-outline" size={40} color={theme.colors.textSecondary} />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              No recordings yet
            </Text>
          </View>
        ) : (
          recordings.map((recording) => (
            <View
              key={recording._id}
              style={[styles.recordingCard, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}
            >
              <View style={styles.recordingHeader}>
                <View style={styles.recordingInfo}>
                  <Text style={[styles.recordingTitle, { color: theme.colors.text }]} numberOfLines={1}>
                    {recording.roomTitle}
                  </Text>
                  <View style={styles.recordingMeta}>
                    <Text style={[styles.recordingDate, { color: theme.colors.textSecondary }]}>
                      {formatDate(recording.startedAt)}
                    </Text>
                    <Text style={[styles.recordingDuration, { color: theme.colors.textSecondary }]}>
                      {formatDurationMs(recording.durationMs)}
                    </Text>
                    <View style={[styles.accessBadge, {
                      backgroundColor: recording.access === 'public' ? `${theme.colors.primary}1A` : '#FF98001A',
                    }]}>
                      <MaterialCommunityIcons
                        name={recording.access === 'public' ? 'earth' : 'lock'}
                        size={10}
                        color={recording.access === 'public' ? theme.colors.primary : '#FF9800'}
                      />
                      <Text style={[styles.accessBadgeText, {
                        color: recording.access === 'public' ? theme.colors.primary : '#FF9800',
                      }]}>
                        {recording.access === 'public' ? 'Public' : 'Participants'}
                      </Text>
                    </View>
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => handlePlay(recording)}
                  disabled={playingId === recording._id}
                  style={[styles.playButton, { backgroundColor: theme.colors.primary }]}
                >
                  {playingId === recording._id ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" />
                  )}
                </TouchableOpacity>
              </View>

              {isHost && (
                <View style={[styles.recordingActions, { borderTopColor: theme.colors.border }]}>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => handleToggleAccess(recording)}
                  >
                    <MaterialCommunityIcons
                      name={recording.access === 'public' ? 'lock' : 'earth'}
                      size={16}
                      color={theme.colors.textSecondary}
                    />
                    <Text style={[styles.actionText, { color: theme.colors.textSecondary }]}>
                      {recording.access === 'public' ? 'Make private' : 'Make public'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => handleDelete(recording)}
                  >
                    <MaterialCommunityIcons name="delete-outline" size={16} color="#FF4458" />
                    <Text style={[styles.actionText, { color: '#FF4458' }]}>Delete</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    gap: 12,
  },
  emptyText: { fontSize: 15, fontWeight: '500' },
  recordingCard: {
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    overflow: 'hidden',
  },
  recordingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  recordingInfo: { flex: 1, gap: 4 },
  recordingTitle: { fontSize: 15, fontWeight: '600' },
  recordingMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  recordingDate: { fontSize: 12, fontWeight: '500' },
  recordingDuration: { fontSize: 12, fontWeight: '500' },
  accessBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  accessBadgeText: { fontSize: 10, fontWeight: '600' },
  playButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingActions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 14,
    gap: 16,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionText: { fontSize: 12, fontWeight: '500' },
});
