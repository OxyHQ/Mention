import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  RefreshControl,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RoomCard, useLiveRoom, type Room } from '@mention/agora-shared';

import { useTheme } from '@/hooks/useTheme';
import { EmptyState } from '@/components/EmptyState';
import { useRooms, useRoomsQueryInvalidation } from '@/hooks/useRoomsQuery';

export default function ExploreScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { joinLiveRoom } = useLiveRoom();

  const [searchQuery, setSearchQuery] = useState('');

  const { data: liveRooms = [], isRefetching: liveRefetching } = useRooms('live');
  const { data: scheduledRooms = [], isRefetching: scheduledRefetching } = useRooms('scheduled');
  const { invalidateRoomLists } = useRoomsQueryInvalidation();
  const rooms = [...liveRooms, ...scheduledRooms];
  const refreshing = liveRefetching || scheduledRefetching;
  const onRefresh = () => { invalidateRoomLists(); };

  const filteredRooms = searchQuery.trim()
    ? rooms.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.topic?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : rooms;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Explore</Text>
      </View>

      <View style={[styles.searchBar, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
        <MaterialCommunityIcons name="magnify" size={18} color={theme.colors.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: theme.colors.text }]}
          placeholder="Search rooms..."
          placeholderTextColor={theme.colors.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        }
      >
        {filteredRooms.length > 0 ? (
          <View style={styles.cardList}>
            {filteredRooms.map((room) => (
              <RoomCard
                key={room._id}
                room={room}
                onPress={() => {
                  if (room.status === 'live') joinLiveRoom(room._id);
                }}
              />
            ))}
          </View>
        ) : (
          <EmptyState
            animation={require('@/assets/lottie/onair.json')}
            title={searchQuery.trim() ? 'No results' : 'No rooms available'}
            subtitle={searchQuery.trim() ? 'No rooms match your search' : 'Rooms will appear here when they go live'}
          />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  headerTitle: { fontSize: 28, fontWeight: '800' },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
  },
  searchInput: { flex: 1, fontSize: 15 },
  scrollContent: { paddingBottom: 100 },
  cardList: { paddingHorizontal: 16 },
});
