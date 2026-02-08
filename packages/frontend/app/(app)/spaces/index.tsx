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

import { ThemedText } from '@/components/ThemedText';
import { Spaces as SpacesIcon } from '@/assets/icons/spaces-icon';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/common/EmptyState';
import SpaceCard from '@/components/SpaceCard';
import SEO from '@/components/SEO';

import { useTheme } from '@/hooks/useTheme';
import { useSpaceUsers } from '@/hooks/useSpaceUsers';
import { useLiveSpace } from '@/context/LiveSpaceContext';
import { spacesService, type Space } from '@/services/spacesService';
import { BottomSheetContext } from '@/context/BottomSheetContext';

const CreateSpaceSheet = lazy(() => import('@/components/spaces/CreateSpaceSheet'));

const SpacesScreen = () => {
  const theme = useTheme();
  const bottomSheet = useContext(BottomSheetContext);
  const { joinLiveSpace } = useLiveSpace();
  const [liveSpaces, setLiveSpaces] = useState<Space[]>([]);
  const [scheduledSpaces, setScheduledSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadSpaces = useCallback(async () => {
    try {
      setLoading(true);
      const [live, scheduled] = await Promise.all([
        spacesService.getSpaces('live'),
        spacesService.getSpaces('scheduled'),
      ]);
      setLiveSpaces(live);
      setScheduledSpaces(scheduled);
    } catch (error) {
      console.warn('Failed to load spaces', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadSpaces();
  }, [loadSpaces]);

  const openCreateSheet = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <Suspense fallback={null}>
        <CreateSpaceSheet
          onClose={() => bottomSheet.openBottomSheet(false)}
          mode="standalone"
          onSpaceCreated={(space) => {
            if (!space.scheduledStart) {
              joinLiveSpace(space._id);
            }
            loadSpaces();
          }}
        />
      </Suspense>
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, joinLiveSpace, loadSpaces]);

  // Resolve all host IDs to user profiles
  const allHostIds = [...liveSpaces, ...scheduledSpaces].map((s) => s.host).filter(Boolean);
  useSpaceUsers(allHostIds);

  const hasSpaces = liveSpaces.length > 0 || scheduledSpaces.length > 0;

  return (
    <>
      <SEO title="Spaces" description="Join live audio conversations" />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: 'Spaces',
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
          {!loading && !hasSpaces ? (
            <EmptyState
              title="No spaces available"
              subtitle="Create a space to start a live audio conversation or schedule one for later"
              customIcon={<SpacesIcon size={48} color={theme.colors.textSecondary} />}
              action={{
                label: 'Create Space',
                onPress: openCreateSheet,
              }}
              containerStyle={styles.emptyState}
            />
          ) : (
            <>
              {liveSpaces.length > 0 && (
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
                  {liveSpaces.map((space) => (
                    <SpaceCard
                      key={space._id}
                      space={space}
                      onPress={() => joinLiveSpace(space._id)}
                    />
                  ))}
                </View>
              )}

              {scheduledSpaces.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primary }]}>
                      <Ionicons name="calendar" size={18} color={theme.colors.card} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <ThemedText type="subtitle">Upcoming</ThemedText>
                      <Text style={[styles.sectionSubtitle, { color: theme.colors.textSecondary }]}>
                        Scheduled spaces
                      </Text>
                    </View>
                  </View>
                  {scheduledSpaces.map((space) => (
                    <SpaceCard
                      key={space._id}
                      space={space}
                      onPress={() => router.push(`/spaces/${space._id}`)}
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
