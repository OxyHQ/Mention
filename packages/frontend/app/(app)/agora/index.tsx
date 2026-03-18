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
import { Agora as AgoraIcon } from '@mention/agora-shared';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/common/EmptyState';
import RoomCard from '@/components/RoomCard';
import SEO from '@/components/SEO';

import { useTheme } from '@oxyhq/bloom/theme';
import { useRoomUsers } from '@/hooks/useRoomUsers';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService, type Room } from '@/services/roomsService';
import { logger } from '@/lib/logger';
import { BottomSheetContext } from '@/context/BottomSheetContext';

const CreateRoomSheet = lazy(() => import('@/components/rooms/CreateRoomSheet'));

const AgoraScreen = () => {
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
      logger.warn('Failed to load rooms', { error });
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
          onRoomCreated={(room) => {
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
      <SafeAreaView className="flex-1 bg-background">
        <Header
          options={{
            title: 'Agora',
            rightComponents: [
              <TouchableOpacity
                key="create"
                onPress={openCreateSheet}
                className="flex-row items-center px-3 py-1.5 rounded-full gap-1 bg-primary"
              >
                <Ionicons name="add" size={20} color={theme.colors.card} />
                <Text className="text-sm font-semibold text-primary-foreground">Create</Text>
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
              customIcon={<AgoraIcon size={48} className="text-muted-foreground" />}
              action={{
                label: 'Create Room',
                onPress: openCreateSheet,
              }}
              containerStyle={{ paddingVertical: 48, paddingHorizontal: 20 }}
            />
          ) : (
            <>
              {liveRooms.length > 0 && (
                <View className="mt-4 px-4">
                  <View className="flex-row items-center mb-3">
                    <View style={styles.sectionIcon} className="bg-[#FF4458]">
                      <AgoraIcon size={18} color="#FFFFFF" />
                    </View>
                    <View className="flex-1">
                      <ThemedText type="subtitle">Live Now</ThemedText>
                      <Text className="text-[13px] mt-0.5 text-muted-foreground">
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
                <View className="mt-4 px-4">
                  <View className="flex-row items-center mb-3">
                    <View style={styles.sectionIcon} className="bg-primary">
                      <Ionicons name="calendar" size={18} color={theme.colors.card} />
                    </View>
                    <View className="flex-1">
                      <ThemedText type="subtitle">Upcoming</ThemedText>
                      <Text className="text-[13px] mt-0.5 text-muted-foreground">
                        Scheduled rooms
                      </Text>
                    </View>
                  </View>
                  {scheduledRooms.map((room) => (
                    <RoomCard
                      key={room._id}
                      room={room}
                      onPress={() => router.push(`/agora/${room._id}`)}
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
  sectionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
});

export default AgoraScreen;
