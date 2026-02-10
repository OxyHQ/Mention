import React, { useEffect, useState, useCallback, useContext, lazy, Suspense } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import { Agora as SpacesIcon } from '@mention/agora-shared';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/common/EmptyState';
import RoomCard from '@/components/SpaceCard';
import SEO from '@/components/SEO';

import { useTheme } from '@/hooks/useTheme';
import { useRoomUsers } from '@/hooks/useSpaceUsers';
import { useLiveRoom } from '@/context/LiveSpaceContext';
import { roomsService, type Room } from '@/services/spacesService';
import { BottomSheetContext } from '@/context/BottomSheetContext';

const CreateRoomSheet = lazy(() => import('@/components/spaces/CreateSpaceSheet'));

const SpacesScreen = () => {
  const { isAuthenticated } = useAuth();
  const theme = useTheme();
  const bottomSheet = useContext(BottomSheetContext);
  const { joinLiveRoom } = useLiveRoom();
  const [liveRooms, setLiveRooms] = useState<Room[]>([]);
  const [scheduledRooms, setScheduledRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadRooms = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setLoading(true);
      const [live, scheduled] = await Promise.all([
        roomsService.getRooms('live'),
        roomsService.getRooms('scheduled'),
      ]);
      setLiveRooms(live);
      setScheduledRooms(scheduled);
    } catch (error) {
      console.warn('Failed to load rooms', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadRooms();
  }, [loadRooms]);

  const openCreateSheet = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <Suspense fallback={null}>
        <CreateRoomSheet
          onClose={() => bottomSheet.openBottomSheet(false)}
          mode="standalone"
          onSpaceCreated={(room) => {
            if (!room.scheduledStart) {
              joinLiveRoom(room._id);
            }
            loadRooms();
          }}
        />
      </Suspense>
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, joinLiveRoom, loadRooms]);

  // Resolve all host IDs to user profiles
  const allHostIds = [...liveRooms, ...scheduledRooms].map((r) => r.host).filter(Boolean);
  useRoomUsers(allHostIds);

  const hasRooms = liveRooms.length > 0 || scheduledRooms.length > 0;

  return (
    <>
      <SEO title="Agora" description="Join live audio conversations" />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: 'Agora',
            rightComponents: [
              <TouchableOpacity
                key="create"
                onPress={openCreateSheet}
                style={[styles.createButton, { backgroundColor: theme.colors.primary }]}
              >
                <Ionicons name="add" size={20} color={theme.colors.card} />
                <Text style={[styles.createButtonText, { color: theme.colors.card }]}>Create</Text>
              </TouchableOpacity>,
            ],
          }}
          hideBottomBorder={false}
          disableSticky={false}
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          }
          contentContainerStyle={styles.scrollContent}
        >
          {!loading && !hasRooms ? (
            <EmptyState
              title="No rooms available"
              subtitle="Create a room to start a live audio conversation or schedule one for later"
              customIcon={<SpacesIcon size={48} color={theme.colors.textSecondary} />}
              action={{
                label: 'Create Room',
                onPress: openCreateSheet,
              }}
              containerStyle={styles.emptyState}
            />
          ) : (
            <>
              {liveRooms.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionIcon, { backgroundColor: '#FF4458' }]}>
                      <SpacesIcon size={18} color="#FFFFFF" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <ThemedText type="subtitle">Live Now</ThemedText>
                      <Text style={[styles.sectionSubtitle, { color: theme.colors.textSecondary }]}>
                        Join the conversation
                      </Text>
                    </View>
                  </View>
                  {liveRooms.map((room) => (
                    <RoomCard
                      key={room._id}
                      room={room}
                      onPress={() => joinLiveRoom(room._id)}
                    />
                  ))}
                </View>
              )}

              {scheduledRooms.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primary }]}>
                      <Ionicons name="calendar" size={18} color={theme.colors.card} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <ThemedText type="subtitle">Upcoming</ThemedText>
                      <Text style={[styles.sectionSubtitle, { color: theme.colors.textSecondary }]}>
                        Scheduled rooms
                      </Text>
                    </View>
                  </View>
                  {scheduledRooms.map((room) => (
                    <RoomCard
                      key={room._id}
                      room={room}
                      onPress={() => router.push(`/spaces/${room._id}`)}
                    />
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 24,
  },
  section: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  sectionSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 4,
  },
  createButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    paddingVertical: 48,
    paddingHorizontal: 20,
  },
});

export default SpacesScreen;
