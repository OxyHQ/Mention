import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Modal,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import LottieView from 'lottie-react-native';
import {
  SpaceCard,
  CreateSpaceSheet,
  useLiveSpace,
  useSpacesConfig,
  type Space,
} from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';

export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { spacesService } = useSpacesConfig();
  const { joinLiveSpace } = useLiveSpace();

  const [liveSpaces, setLiveSpaces] = useState<Space[]>([]);
  const [scheduledSpaces, setScheduledSpaces] = useState<Space[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const loadSpaces = useCallback(async () => {
    const [live, scheduled] = await Promise.all([
      spacesService.getSpaces('live'),
      spacesService.getSpaces('scheduled'),
    ]);
    setLiveSpaces(live);
    setScheduledSpaces(scheduled);
  }, [spacesService]);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadSpaces();
    setRefreshing(false);
  };

  const handleJoinSpace = (space: Space) => {
    joinLiveSpace(space._id);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Spaces</Text>
        <TouchableOpacity onPress={() => setShowCreate(true)}>
          <Ionicons name="add-circle" size={28} color={theme.colors.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        }
      >
        {/* Live Now */}
        {liveSpaces.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.liveIndicator}>
                <View style={styles.liveDot} />
              </View>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Live Now
              </Text>
            </View>
            {liveSpaces.length > 0 && (
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={liveSpaces}
                keyExtractor={(item) => item._id}
                contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}
                renderItem={({ item }) => (
                  <SpaceCard
                    space={item}
                    variant="compact"
                    onPress={() => handleJoinSpace(item)}
                  />
                )}
              />
            )}
          </View>
        )}

        {/* All Live Spaces (full cards) */}
        {liveSpaces.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeaderPadded}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Join a Space
              </Text>
            </View>
            <View style={styles.cardList}>
              {liveSpaces.map((space) => (
                <SpaceCard
                  key={space._id}
                  space={space}
                  onPress={() => handleJoinSpace(space)}
                />
              ))}
            </View>
          </View>
        )}

        {/* Upcoming */}
        {scheduledSpaces.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeaderPadded}>
              <Ionicons name="calendar" size={18} color={theme.colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Upcoming
              </Text>
            </View>
            <View style={styles.cardList}>
              {scheduledSpaces.map((space) => (
                <SpaceCard
                  key={space._id}
                  space={space}
                  onPress={() => handleJoinSpace(space)}
                />
              ))}
            </View>
          </View>
        )}

        {/* Empty state */}
        {liveSpaces.length === 0 && scheduledSpaces.length === 0 && !refreshing && (
          <View style={styles.emptyState}>
            <LottieView
              source={require('@/assets/lottie/onair.json')}
              autoPlay
              loop
              style={styles.lottie}
            />
            <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
              No spaces yet
            </Text>
            <Text style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
              Start a space and invite people to listen and chat
            </Text>
            <TouchableOpacity
              style={[styles.createButton, { backgroundColor: theme.colors.primary }]}
              onPress={() => setShowCreate(true)}
            >
              <Ionicons name="add" size={20} color="#FFFFFF" />
              <Text style={styles.createButtonText}>Create Space</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <Modal
        visible={showCreate}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowCreate(false)}
      >
        <CreateSpaceSheet
          onClose={() => setShowCreate(false)}
          onSpaceCreated={() => loadSpaces()}
        />
      </Modal>
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
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 28, fontWeight: '800' },
  scrollContent: { paddingBottom: 100 },
  section: { marginTop: 20 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionHeaderPadded: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  liveIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FF4458',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  cardList: { paddingHorizontal: 16 },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 12,
  },
  lottie: { width: 120, height: 120 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptySubtitle: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 24,
    marginTop: 12,
  },
  createButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
