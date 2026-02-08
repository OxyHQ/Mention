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
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetBackdrop, BottomSheetFooter } from '@gorhom/bottom-sheet';
import type { BottomSheetFooterProps } from '@gorhom/bottom-sheet';
import {
  SpaceCard,
  CreateSpaceSheet,
  useLiveSpace,
  useSpacesConfig,
  type Space,
  type CreateSpaceSheetRef,
  type CreateSpaceFormState,
} from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';
import { EmptyState } from '@/components/EmptyState';
import { PrimaryButton } from '@/components/PrimaryButton';

export default function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { spacesService } = useSpacesConfig();
  const { joinLiveSpace } = useLiveSpace();
  const modalRef = useRef<BottomSheetModal>(null);
  const createSheetRef = useRef<CreateSpaceSheetRef>(null);
  const snapPoints = useMemo(() => ['85%'], []);

  const [liveSpaces, setLiveSpaces] = useState<Space[]>([]);
  const [scheduledSpaces, setScheduledSpaces] = useState<Space[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [formState, setFormState] = useState<CreateSpaceFormState>({
    isValid: false,
    loading: false,
    hasScheduledStart: false,
  });

  useEffect(() => {
    if (sheetOpen) {
      modalRef.current?.present();
    }
  }, [sheetOpen]);

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

  const openCreateSheet = useCallback(() => {
    setSheetOpen(true);
  }, []);

  const closeCreateSheet = useCallback(() => {
    modalRef.current?.dismiss();
    setSheetOpen(false);
  }, []);

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

  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props} bottomInset={0}>
        <View style={[sheetStyles.footer, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
          <TouchableOpacity
            style={[
              sheetStyles.primaryButton,
              {
                backgroundColor: formState.isValid ? theme.colors.primary : theme.colors.backgroundSecondary,
                opacity: formState.loading ? 0.6 : 1,
              },
            ]}
            onPress={() => createSheetRef.current?.handleCreateAndStart()}
            disabled={!formState.isValid || formState.loading}
          >
            <MaterialCommunityIcons
              name="play"
              size={20}
              color={formState.isValid ? theme.colors.onPrimary : theme.colors.textSecondary}
            />
            <Text
              style={[sheetStyles.primaryButtonText, { color: formState.isValid ? theme.colors.onPrimary : theme.colors.textSecondary }]}
            >
              {formState.loading ? 'Creating...' : 'Start Now'}
            </Text>
          </TouchableOpacity>

          {formState.hasScheduledStart && (
            <TouchableOpacity
              style={[
                sheetStyles.secondaryButton,
                { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border, opacity: formState.loading ? 0.6 : 1 },
              ]}
              onPress={() => createSheetRef.current?.handleSchedule()}
              disabled={!formState.isValid || formState.loading}
            >
              <MaterialCommunityIcons name="calendar" size={20} color={theme.colors.text} />
              <Text style={[sheetStyles.secondaryButtonText, { color: theme.colors.text }]}>
                Schedule Space
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </BottomSheetFooter>
    ),
    [formState, theme],
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Spaces</Text>
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
              <MaterialCommunityIcons name="calendar" size={18} color={theme.colors.textSecondary} />
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
            <PrimaryButton title="Create Space" onPress={openCreateSheet} style={{ marginTop: 10 }} />
          </EmptyState>
        )}
      </ScrollView>

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: theme.colors.primary }]}
        onPress={openCreateSheet}
        activeOpacity={0.8}
      >
        <MaterialCommunityIcons name="plus" size={28} color={theme.colors.onPrimary} />
      </TouchableOpacity>

      <BottomSheetModal
        ref={modalRef}
        snapPoints={snapPoints}
        enablePanDownToClose
        onDismiss={() => setSheetOpen(false)}
        backdropComponent={renderBackdrop}
        footerComponent={renderFooter}
        backgroundStyle={{ backgroundColor: theme.colors.background, borderRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.textTertiary }}
        style={{ maxWidth: 500, margin: 'auto' }}
      >
        <CreateSpaceSheet
          ref={createSheetRef}
          onClose={closeCreateSheet}
          onSpaceCreated={() => { closeCreateSheet(); loadSpaces(); }}
          ScrollViewComponent={BottomSheetScrollView}
          hideFooter
          onFormStateChange={setFormState}
        />
      </BottomSheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
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
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 80,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
  },
});

const sheetStyles = StyleSheet.create({
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopWidth: 0.5,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 22,
    gap: 6,
  },
  primaryButtonText: { fontSize: 15, fontWeight: '600' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 22,
    borderWidth: 1,
    gap: 6,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '600' },
});
