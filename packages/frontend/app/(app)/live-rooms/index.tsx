import React, { useEffect, useState, useCallback, useContext, lazy, Suspense } from 'react';
import { View, Text, TouchableOpacity, ScrollView, RefreshControl, Platform } from 'react-native';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import { LiveRoomsIcon } from '@syra.fm/sdk';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/common/EmptyState';
import { RoomsListSkeleton } from '@/components/rooms/RoomsListSkeleton';
import RoomCard from '@/components/RoomCard';
import SEO from '@/components/SEO';

import { useTheme } from '@oxyhq/bloom/theme';
import { useRoomUsers } from '@/hooks/useRoomUsers';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService } from '@/lib/liveConfig';
import type { Room } from '@syra.fm/sdk';
import { logger } from '@/lib/logger';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useTranslation } from 'react-i18next';
import { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR } from '@/styles/colors';

const CreateRoomSheet = lazy(() => import('@/components/rooms/CreateRoomSheet'));

const SectionHeader = ({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) => (
  <View className="flex-row items-center mb-3">
    <View className="mr-3">{icon}</View>
    <View className="flex-1">
      <ThemedText type="subtitle">{title}</ThemedText>
      <Text className="text-[13px] mt-0.5 text-muted-foreground">{subtitle}</Text>
    </View>
  </View>
);

const LiveRoomsScreen = () => {
  const { isAuthenticated } = useAuth();
  const theme = useTheme();
  const { t } = useTranslation();
  const bottomSheet = useContext(BottomSheetContext);
  const { joinLiveRoom } = useLiveRoom();
  const [liveRooms, setLiveRooms] = useState<Room[]>([]);
  const [scheduledRooms, setScheduledRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadRooms = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setLoading(true);
      setLoadFailed(false);
      const [live, scheduled] = await Promise.all([
        roomsService.getRooms('live'),
        roomsService.getRooms('scheduled'),
      ]);
      setLiveRooms(live);
      setScheduledRooms(scheduled);
    } catch (error) {
      logger.warn('Failed to load rooms', { error });
      setLoadFailed(true);
    } finally {
      setLoading(false);
      setHasFetched(true);
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
  const showSkeleton = loading && !hasFetched;
  // A failed refresh keeps the rooms already on screen; the error state only
  // takes over when there is nothing left to show.
  const showError = loadFailed && !hasRooms;

  const body = showSkeleton ? (
    <RoomsListSkeleton />
  ) : showError ? (
    <EmptyState
      icon={{ name: 'cloud-offline-outline' }}
      error={{
        title: t('agora.loadRoomsFailedTitle', { defaultValue: "Couldn't load rooms" }),
        message: t('agora.loadRoomsFailedMessage', {
          defaultValue: 'Check your connection and try again.',
        }),
        onRetry: loadRooms,
      }}
      containerStyle={{ paddingVertical: 48, paddingHorizontal: 20 }}
    />
  ) : !hasRooms ? (
    <EmptyState
      title="No rooms available"
      subtitle="Create a room to start a live audio conversation or schedule one for later"
      customIcon={<LiveRoomsIcon size={48} color={theme.colors.textSecondary} />}
      action={{
        label: t('agora.createRoom'),
        onPress: openCreateSheet,
      }}
      containerStyle={{ paddingVertical: 48, paddingHorizontal: 20 }}
    />
  ) : (
    <>
      {liveRooms.length > 0 && (
        <View className="mt-4 px-4">
          <SectionHeader
            icon={
              <View
                className="w-9 h-9 items-center justify-center rounded-full"
                style={{ backgroundColor: LIVE_INDICATOR_COLOR }}
              >
                <LiveRoomsIcon size={18} color={LIVE_INDICATOR_FOREGROUND_COLOR} />
              </View>
            }
            title={t('agora.liveNow')}
            subtitle="Join the conversation"
          />
          {liveRooms.map((room) => (
            <RoomCard key={room._id} room={room} onPress={() => joinLiveRoom(room._id)} />
          ))}
        </View>
      )}

      {scheduledRooms.length > 0 && (
        <View className="mt-4 px-4">
          <SectionHeader
            icon={
              <View className="w-9 h-9 items-center justify-center rounded-full bg-primary">
                <Ionicons name="calendar" size={18} color={theme.colors.primaryForeground} />
              </View>
            }
            title={t('agora.upcoming')}
            subtitle="Scheduled rooms"
          />
          {scheduledRooms.map((room) => (
            <RoomCard
              key={room._id}
              room={room}
              onPress={() => router.push(`/live-rooms/${room._id}`)}
            />
          ))}
        </View>
      )}
    </>
  );

  return (
    <>
      <SEO title="Live Rooms" description="Join live audio conversations" />
      <SafeAreaView className="flex-1 bg-background">
        <Header
          options={{
            title: t('agora.title'),
            rightComponents: [
              <TouchableOpacity
                key="create"
                onPress={openCreateSheet}
                className="flex-row items-center px-3 py-1.5 rounded-full gap-1 bg-primary"
              >
                <Ionicons name="add" size={20} color={theme.colors.primaryForeground} />
                <Text className="text-sm font-semibold text-primary-foreground">Create</Text>
              </TouchableOpacity>,
            ],
          }}
          hideBottomBorder={false}
          disableSticky={false}
        />

        {/* WEB hands scroll to the shared panel/document (no nested scroller that
            would break sticky rails + window scroll restoration); NATIVE keeps a
            ScrollView (+ pull-to-refresh) as the screen's scroller. */}
        {Platform.OS === 'web' ? (
          <View className="pb-6">{body}</View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
            contentContainerClassName="pb-6"
          >
            {body}
          </ScrollView>
        )}
      </SafeAreaView>
    </>
  );
};

export default LiveRoomsScreen;
