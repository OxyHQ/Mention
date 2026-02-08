import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BottomSheet, { BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import {
  SpaceCard,
  CreateSpaceSheet,
  useLiveSpace,
  useSpacesConfig,
  type Space,
} from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';
import { EmptyState } from '@/components/EmptyState';

export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { spacesService } = useSpacesConfig();
  const { joinLiveSpace } = useLiveSpace();
  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['85%'], []);

  const [liveSpaces, setLiveSpaces] = useState<Space[]>([]);
  const [scheduledSpaces, setScheduledSpaces] = useState<Space[]>([]);
  const [refreshing, setRefreshing] = useState(false);

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

  const openCreateSheet = () => {
    bottomSheetRef.current?.expand();
  };

  const closeCreateSheet = () => {
    bottomSheetRef.current?.close();
  };

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
      />
    ),
    [],
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Spaces</Text>
        <TouchableOpacity onPress={openCreateSheet}>
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
          <EmptyState
            animation={require('@/assets/lottie/onair.json')}
            title="No spaces yet"
            subtitle="Start a space and invite people to listen and chat"
          >
            <TouchableOpacity
              style={[styles.createButton, { backgroundColor: theme.colors.primary }]}
              onPress={openCreateSheet}
            >
              <Ionicons name="add" size={20} color="#FFFFFF" />
              <Text style={styles.createButtonText}>Create Space</Text>
            </TouchableOpacity>
          </EmptyState>
        )}
      </ScrollView>

      <BottomSheet
        ref={bottomSheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: theme.colors.background, borderRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
      >
        <CreateSpaceSheet
          onClose={closeCreateSheet}
          onSpaceCreated={() => loadSpaces()}
        />
      </BottomSheet>
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
