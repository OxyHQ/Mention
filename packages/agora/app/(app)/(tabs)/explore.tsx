import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  FlatList,
  Platform,
  Image,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { RoomCard, useLiveRoom, type Room, type House } from '@mention/agora-shared';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import { EmptyState } from '@/components/EmptyState';
import { CreateHouseSheet } from '@/components/CreateHouseSheet';
import { useRooms, usePublicHouses, useRoomsQueryInvalidation } from '@/hooks/useRoomsQuery';
import { getCachedFileDownloadUrl } from '@/utils/imageUrlCache';

const TYPE_FILTERS = [
  { value: null, label: 'All', icon: null },
  { value: 'talk', label: 'Talk', icon: 'microphone' as const },
  { value: 'stage', label: 'Stage', icon: 'account-voice' as const },
  { value: 'broadcast', label: 'Broadcast', icon: 'broadcast' as const },
] as const;

function HouseCard({ house, onPress }: { house: House; onPress?: () => void }) {
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    if (house.avatar && oxyServices) {
      getCachedFileDownloadUrl(oxyServices, house.avatar).then(setAvatarUrl);
    }
  }, [house.avatar, oxyServices]);

  return (
    <TouchableOpacity
      style={[houseStyles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
      activeOpacity={0.7}
      onPress={onPress}
    >
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={houseStyles.avatar} />
      ) : (
        <View style={[houseStyles.avatar, houseStyles.avatarFallback, { backgroundColor: theme.colors.primary + '25' }]}>
          <Text style={[houseStyles.avatarText, { color: theme.colors.primary }]}>
            {house.name.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <Text style={[houseStyles.name, { color: theme.colors.text }]} numberOfLines={1}>
        {house.name}
      </Text>
      <Text style={[houseStyles.meta, { color: theme.colors.textSecondary }]}>
        {house.members.length} {house.members.length === 1 ? 'member' : 'members'}
      </Text>
      {house.tags && house.tags.length > 0 && (
        <Text style={[houseStyles.tags, { color: theme.colors.textTertiary }]} numberOfLines={1}>
          {house.tags.slice(0, 2).join(' · ')}
        </Text>
      )}
    </TouchableOpacity>
  );
}

export default function ExploreScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { joinLiveRoom } = useLiveRoom();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const { data: liveRooms = [], isRefetching: liveRefetching } = useRooms('live', selectedType || undefined);
  const { data: scheduledRooms = [], isRefetching: scheduledRefetching } = useRooms('scheduled', selectedType || undefined);
  const { data: publicHouses = [] } = usePublicHouses();
  const { invalidateRoomLists } = useRoomsQueryInvalidation();
  const refreshing = liveRefetching || scheduledRefetching;
  const onRefresh = () => { invalidateRoomLists(); };

  const modalRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['85%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [],
  );

  const openCreateHouse = () => {
    modalRef.current?.present();
  };

  const closeCreateHouse = () => {
    modalRef.current?.dismiss();
  };

  // Client-side search filter on top of server-side type filter
  const filterBySearch = (rooms: Room[]) => {
    if (!searchQuery.trim()) return rooms;
    const q = searchQuery.toLowerCase();
    return rooms.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.topic?.toLowerCase().includes(q)
    );
  };

  const filteredLive = filterBySearch(liveRooms);
  const filteredScheduled = filterBySearch(scheduledRooms);
  const hasRooms = filteredLive.length > 0 || filteredScheduled.length > 0;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Explore</Text>
      </View>

      {/* Search Bar */}
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

      {/* Type Filter Chips */}
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={TYPE_FILTERS}
        keyExtractor={(item) => item.label}
        contentContainerStyle={styles.filterChips}
        renderItem={({ item }) => {
          const selected = selectedType === item.value;
          return (
            <TouchableOpacity
              style={[
                styles.filterChip,
                {
                  backgroundColor: selected ? theme.colors.primary : theme.colors.backgroundSecondary,
                  borderColor: selected ? theme.colors.primary : theme.colors.border,
                },
              ]}
              onPress={() => setSelectedType(item.value)}
            >
              {item.icon && (
                <MaterialCommunityIcons
                  name={item.icon}
                  size={14}
                  color={selected ? '#FFFFFF' : theme.colors.textSecondary}
                />
              )}
              <Text style={[styles.filterChipText, { color: selected ? '#FFFFFF' : theme.colors.text }]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          );
        }}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        }
      >
        {/* Houses Section */}
        {!searchQuery.trim() && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialCommunityIcons name="home-group" size={18} color={theme.colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Houses</Text>
              <TouchableOpacity onPress={openCreateHouse} style={{ marginLeft: 'auto' }}>
                <MaterialCommunityIcons name="plus-circle-outline" size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {publicHouses.length > 0 ? (
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={publicHouses}
                keyExtractor={(item) => item._id}
                contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}
                renderItem={({ item }) => (
                  <HouseCard
                    house={item}
                    onPress={() => router.push({ pathname: '/(app)/houses/[id]', params: { id: item._id } })}
                  />
                )}
              />
            ) : (
              <TouchableOpacity
                style={[styles.createHouseCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
                onPress={openCreateHouse}
                activeOpacity={0.7}
              >
                <MaterialCommunityIcons name="home-plus" size={28} color={theme.colors.primary} />
                <Text style={[styles.createHouseTitle, { color: theme.colors.text }]}>Create a House</Text>
                <Text style={[styles.createHouseSubtitle, { color: theme.colors.textSecondary }]}>
                  Start a community for your audience
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Live Now */}
        {filteredLive.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.liveIndicator}>
                <View style={styles.liveDot} />
              </View>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Live Now
              </Text>
              <Text style={[styles.sectionCount, { color: theme.colors.textSecondary }]}>
                {filteredLive.length}
              </Text>
            </View>
            <View style={styles.cardList}>
              {filteredLive.map((room) => (
                <RoomCard
                  key={room._id}
                  room={room}
                  onPress={() => joinLiveRoom(room._id)}
                />
              ))}
            </View>
          </View>
        )}

        {/* Upcoming */}
        {filteredScheduled.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialCommunityIcons name="calendar" size={18} color={theme.colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Upcoming
              </Text>
              <Text style={[styles.sectionCount, { color: theme.colors.textSecondary }]}>
                {filteredScheduled.length}
              </Text>
            </View>
            <View style={styles.cardList}>
              {filteredScheduled.map((room) => (
                <RoomCard
                  key={room._id}
                  room={room}
                  onPress={() => {
                    if (room.status === 'live') joinLiveRoom(room._id);
                  }}
                />
              ))}
            </View>
          </View>
        )}

        {/* Empty state */}
        {!hasRooms && !refreshing && (
          <EmptyState
            animation={require('@/assets/lottie/onair.json')}
            title={searchQuery.trim() ? 'No results' : 'No rooms available'}
            subtitle={
              searchQuery.trim()
                ? 'No rooms match your search'
                : selectedType
                  ? `No ${selectedType} rooms right now`
                  : 'Rooms will appear here when they go live'
            }
          />
        )}
      </ScrollView>

      <BottomSheetModal
        ref={modalRef}
        snapPoints={snapPoints}
        enablePanDownToClose
        onDismiss={() => {}}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: theme.colors.background, borderRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
        style={{ maxWidth: 500, margin: 'auto' }}
      >
        <BottomSheetScrollView>
          <CreateHouseSheet
            onClose={closeCreateHouse}
            onHouseCreated={closeCreateHouse}
          />
        </BottomSheetScrollView>
      </BottomSheetModal>
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
  filterChips: {
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    gap: 5,
  },
  filterChipText: { fontSize: 13, fontWeight: '500' },
  scrollContent: { paddingBottom: 100 },
  section: { marginTop: 16 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  sectionCount: { fontSize: 14, fontWeight: '500' },
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
  createHouseCard: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    gap: 6,
  },
  createHouseTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 4,
  },
  createHouseSubtitle: {
    fontSize: 12,
    textAlign: 'center',
  },
});

const houseStyles = StyleSheet.create({
  card: {
    width: 140,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    alignItems: 'center',
    gap: 6,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginBottom: 2,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '700',
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  meta: {
    fontSize: 11,
  },
  tags: {
    fontSize: 10,
    textAlign: 'center',
  },
});
