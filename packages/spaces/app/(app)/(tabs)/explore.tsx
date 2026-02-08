import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SpaceCard, useLiveSpace, useSpacesConfig, type Space } from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';
import { EmptyState } from '@/components/EmptyState';

export default function ExploreScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { spacesService } = useSpacesConfig();
  const { joinLiveSpace } = useLiveSpace();

  const [searchQuery, setSearchQuery] = useState('');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadSpaces = useCallback(async () => {
    const [live, scheduled] = await Promise.all([
      spacesService.getSpaces('live'),
      spacesService.getSpaces('scheduled'),
    ]);
    setSpaces([...live, ...scheduled]);
  }, [spacesService]);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadSpaces();
    setRefreshing(false);
  };

  const filteredSpaces = searchQuery.trim()
    ? spaces.filter(
        (s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.topic?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : spaces;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Explore</Text>
      </View>

      <View style={[styles.searchBar, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
        <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: theme.colors.text }]}
          placeholder="Search spaces..."
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
        {filteredSpaces.length > 0 ? (
          <View style={styles.cardList}>
            {filteredSpaces.map((space) => (
              <SpaceCard
                key={space._id}
                space={space}
                onPress={() => {
                  if (space.status === 'live') joinLiveSpace(space._id);
                }}
              />
            ))}
          </View>
        ) : (
          <EmptyState
            animation={require('@/assets/lottie/onair.json')}
            title={searchQuery.trim() ? 'No results' : 'No spaces available'}
            subtitle={searchQuery.trim() ? 'No spaces match your search' : 'Spaces will appear here when they go live'}
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
