import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import type { ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useAgoraConfig } from '../context/AgoraConfigContext';
import type { AgoraTheme } from '../types';
import type { PodcastResult, EpisodeListItem } from '../services/spacesService';

const SEARCH_DEBOUNCE_MS = 350;

type AvatarComponentType = React.ComponentType<{
  size: number;
  source?: string;
  shape?: string;
  style?: ViewStyle;
}>;

interface PodcastStreamPickerProps {
  onSelectEpisode: (syraPodcastId: string, episodeId: string) => void;
}

function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedSecs = String(secs).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSecs}`;
  }
  return `${minutes}:${paddedSecs}`;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const ShowRow = memo(function ShowRow({
  show,
  theme,
  AvatarComponent,
  onSelect,
}: {
  show: PodcastResult;
  theme: AgoraTheme;
  AvatarComponent: AvatarComponentType;
  onSelect: (show: PodcastResult) => void;
}) {
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => onSelect(show)}>
      <AvatarComponent size={44} source={show.artworkUrl} shape="squircle" />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {show.title}
        </Text>
        {!!show.author && (
          <Text style={[styles.rowSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {show.author}
          </Text>
        )}
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
});

const EpisodeRow = memo(function EpisodeRow({
  episode,
  theme,
  AvatarComponent,
  onSelect,
}: {
  episode: EpisodeListItem;
  theme: AgoraTheme;
  AvatarComponent: AvatarComponentType;
  onSelect: (episode: EpisodeListItem) => void;
}) {
  const meta = [formatDuration(episode.durationSec), formatDate(episode.publishedAt)]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => onSelect(episode)}>
      <AvatarComponent size={44} source={episode.artworkUrl} shape="squircle" />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={2}>
          {episode.title}
        </Text>
        {!!meta && (
          <Text style={[styles.rowSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {meta}
          </Text>
        )}
      </View>
      <MaterialCommunityIcons name="play-circle" size={26} color={theme.colors.primary} />
    </TouchableOpacity>
  );
});

/**
 * Self-contained two-level podcast picker for the live-room stream setup. Level 1
 * is a debounced Syra show search; tapping a show drills into Level 2, its episode
 * list. Tapping an episode reports `(syraPodcastId, episodeId)` to the parent — the
 * picker owns NO room/stream logic. Ships inside agora-shared, so it depends only
 * on `useAgoraConfig()` injection and never imports from a host app (`@/`).
 */
export function PodcastStreamPicker({ onSelectEpisode }: PodcastStreamPickerProps) {
  const { useTheme, agoraService, AvatarComponent } = useAgoraConfig();
  const theme = useTheme();

  // Level 1 — show search
  const [query, setQuery] = useState('');
  const [shows, setShows] = useState<PodcastResult[]>([]);
  const [showsNextOffset, setShowsNextOffset] = useState(0);
  const [showsHasMore, setShowsHasMore] = useState(false);
  const [showsLoading, setShowsLoading] = useState(false);
  const [showsLoadingMore, setShowsLoadingMore] = useState(false);
  const showsSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Level 2 — episode list
  const [selectedShow, setSelectedShow] = useState<PodcastResult | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [episodesNextOffset, setEpisodesNextOffset] = useState(0);
  const [episodesHasMore, setEpisodesHasMore] = useState(false);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesLoadingMore, setEpisodesLoadingMore] = useState(false);
  const episodesSeqRef = useRef(0);

  const runSearch = useCallback(
    async (rawQuery: string, offset: number) => {
      const trimmed = rawQuery.trim();
      if (!trimmed) {
        showsSeqRef.current += 1;
        setShows([]);
        setShowsHasMore(false);
        setShowsNextOffset(0);
        setShowsLoading(false);
        setShowsLoadingMore(false);
        return;
      }
      const seq = offset === 0 ? (showsSeqRef.current += 1) : showsSeqRef.current;
      if (offset === 0) setShowsLoading(true);
      else setShowsLoadingMore(true);

      const result = await agoraService.searchPodcasts(trimmed, offset);
      if (seq !== showsSeqRef.current) return; // superseded by a newer query

      setShows((prev) => (offset === 0 ? result.items : [...prev, ...result.items]));
      setShowsHasMore(result.hasMore);
      setShowsNextOffset(result.offset + result.items.length);
      setShowsLoading(false);
      setShowsLoadingMore(false);
    },
    [agoraService],
  );

  const handleQueryChange = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Show the spinner for the debounce window so a fresh query never briefly
      // renders the "No podcasts found" empty state before the request fires.
      if (text.trim()) setShowsLoading(true);
      debounceRef.current = setTimeout(() => {
        runSearch(text, 0);
      }, SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  const handleClearQuery = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuery('');
    runSearch('', 0);
  }, [runSearch]);

  const handleShowsEndReached = useCallback(() => {
    if (showsLoading || showsLoadingMore || !showsHasMore) return;
    runSearch(query, showsNextOffset);
  }, [showsLoading, showsLoadingMore, showsHasMore, runSearch, query, showsNextOffset]);

  const loadEpisodes = useCallback(
    async (syraPodcastId: string, offset: number) => {
      const seq = offset === 0 ? (episodesSeqRef.current += 1) : episodesSeqRef.current;
      if (offset === 0) setEpisodesLoading(true);
      else setEpisodesLoadingMore(true);

      const result = await agoraService.getPodcastEpisodes(syraPodcastId, offset);
      if (seq !== episodesSeqRef.current) return; // superseded by a newer show

      setEpisodes((prev) => (offset === 0 ? result.items : [...prev, ...result.items]));
      setEpisodesHasMore(result.hasMore);
      setEpisodesNextOffset(result.offset + result.items.length);
      setEpisodesLoading(false);
      setEpisodesLoadingMore(false);
    },
    [agoraService],
  );

  const handleSelectShow = useCallback(
    (show: PodcastResult) => {
      episodesSeqRef.current += 1;
      setSelectedShow(show);
      setEpisodes([]);
      setEpisodesHasMore(false);
      setEpisodesNextOffset(0);
      loadEpisodes(show.syraPodcastId, 0);
    },
    [loadEpisodes],
  );

  const handleBack = useCallback(() => {
    episodesSeqRef.current += 1;
    setSelectedShow(null);
    setEpisodes([]);
    setEpisodesHasMore(false);
    setEpisodesNextOffset(0);
    setEpisodesLoading(false);
    setEpisodesLoadingMore(false);
  }, []);

  const handleEpisodesEndReached = useCallback(() => {
    if (!selectedShow || episodesLoading || episodesLoadingMore || !episodesHasMore) return;
    loadEpisodes(selectedShow.syraPodcastId, episodesNextOffset);
  }, [selectedShow, episodesLoading, episodesLoadingMore, episodesHasMore, loadEpisodes, episodesNextOffset]);

  const handleSelectEpisode = useCallback(
    (episode: EpisodeListItem) => {
      if (!selectedShow) return;
      onSelectEpisode(selectedShow.syraPodcastId, episode.episodeId);
    },
    [selectedShow, onSelectEpisode],
  );

  // Cancel any pending debounced search when the picker unmounts.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const hasQuery = query.trim().length > 0;

  if (selectedShow) {
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backHeader} activeOpacity={0.7} onPress={handleBack} hitSlop={8}>
          <MaterialCommunityIcons name="chevron-left" size={24} color={theme.colors.text} />
          <Text style={[styles.backTitle, { color: theme.colors.text }]} numberOfLines={1}>
            {selectedShow.title}
          </Text>
        </TouchableOpacity>

        {episodesLoading ? (
          <View style={styles.stateBox}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        ) : episodes.length === 0 ? (
          <View style={styles.stateBox}>
            <MaterialCommunityIcons name="playlist-remove" size={32} color={theme.colors.textSecondary} />
            <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>No episodes found</Text>
          </View>
        ) : (
          <FlatList
            data={episodes}
            keyExtractor={(item) => item.episodeId}
            renderItem={({ item }) => (
              <EpisodeRow
                episode={item}
                theme={theme}
                AvatarComponent={AvatarComponent}
                onSelect={handleSelectEpisode}
              />
            )}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={handleEpisodesEndReached}
            onEndReachedThreshold={0.4}
            contentContainerStyle={styles.listContent}
            ListFooterComponent={
              episodesLoadingMore ? (
                <View style={styles.footerLoader}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                </View>
              ) : null
            }
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <View style={[styles.searchRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
          <MaterialCommunityIcons name="magnify" size={18} color={theme.colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: theme.colors.text }]}
            placeholder="Search podcasts"
            placeholderTextColor={theme.colors.textSecondary}
            value={query}
            onChangeText={handleQueryChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={handleClearQuery} hitSlop={8}>
              <MaterialCommunityIcons name="close-circle" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {!hasQuery ? (
        <View style={styles.stateBox}>
          <MaterialCommunityIcons name="podcast" size={32} color={theme.colors.textSecondary} />
          <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>
            Search for a podcast to stream
          </Text>
        </View>
      ) : showsLoading ? (
        <View style={styles.stateBox}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : shows.length === 0 ? (
        <View style={styles.stateBox}>
          <MaterialCommunityIcons name="magnify-close" size={32} color={theme.colors.textSecondary} />
          <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>No podcasts found</Text>
        </View>
      ) : (
        <FlatList
          data={shows}
          keyExtractor={(item) => item.syraPodcastId}
          renderItem={({ item }) => (
            <ShowRow show={item} theme={theme} AvatarComponent={AvatarComponent} onSelect={handleSelectShow} />
          )}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onEndReached={handleShowsEndReached}
          onEndReachedThreshold={0.4}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={
            showsLoadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  backHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
  },
  backTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  listContent: { paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowSubtitle: { fontSize: 13 },
  stateBox: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 40,
  },
  stateText: { fontSize: 14 },
  footerLoader: { paddingVertical: 16 },
});
