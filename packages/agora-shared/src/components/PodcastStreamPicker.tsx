import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Linking,
} from 'react-native';
import type { ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useAgoraConfig, type PinnedPodcast } from '../context/AgoraConfigContext';
import type { AgoraTheme } from '../types';
import type { PodcastResult, EpisodeListItem } from '../services/spacesService';

const SEARCH_DEBOUNCE_MS = 350;

/** Public Syra web base — the "Open in Syra" affordance links to `/podcasts/:id`. */
const SYRA_WEB_BASE_URL = 'https://syra.fm';

/**
 * English source copy for every user-facing string in the picker. Hosts with an
 * i18n layer (the Mention frontend) inject `t` via `useAgoraConfig()` and these
 * are never read; hosts without one (the standalone Agora app) fall back to
 * these. Keys mirror the `agora.podcastStream.*` entries in the app locale files.
 */
const DEFAULT_STRINGS: Record<string, string> = {
  'agora.podcastStream.disclaimer':
    "You're responsible for having the rights to stream this audio into your room.",
  'agora.podcastStream.searchPlaceholder': 'Search podcasts',
  'agora.podcastStream.searchHint': 'Search for a podcast to stream',
  'agora.podcastStream.pinnedTitle': 'Stream my pinned podcast',
  'agora.podcastStream.emptyShows': 'No podcasts found',
  'agora.podcastStream.emptyEpisodes': 'No episodes found',
  'agora.podcastStream.errorShows': "Couldn't load podcasts. Check your connection and try again.",
  'agora.podcastStream.errorEpisodes': "Couldn't load episodes. Check your connection and try again.",
  'agora.podcastStream.retry': 'Retry',
  'agora.podcastStream.openInSyra': 'Open in Syra',
  'agora.podcastStream.openFailed': "Couldn't open Syra",
  'agora.podcastStream.addToQueue': 'Add to queue',
  'agora.podcastStream.removeFromQueue': 'Remove from queue',
  'agora.podcastStream.playQueue': 'Play episodes',
  'agora.podcastStream.clearQueue': 'Clear',
};

type TranslateFn = (key: string) => string;

type AvatarComponentType = React.ComponentType<{
  size: number;
  source?: string;
  shape?: string;
  style?: ViewStyle;
}>;

/** One episode selected for the up-next queue. The show id is always known here. */
export interface PodcastQueueSelection {
  syraPodcastId: string;
  episodeId: string;
}

interface PodcastStreamPickerProps {
  onSelectEpisode: (syraPodcastId: string, episodeId: string) => void;
  /**
   * Start a multi-episode session: the first item plays immediately, the rest
   * become the room's up-next queue. Optional — hosts that omit it get the
   * single-tap "play this now" flow only, and the queue affordances (per-row "+"
   * and the footer) are hidden.
   */
  onStartQueue?: (items: PodcastQueueSelection[]) => void;
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
  queueEnabled,
  isQueued,
  onToggleQueue,
  queueActionLabel,
}: {
  episode: EpisodeListItem;
  theme: AgoraTheme;
  AvatarComponent: AvatarComponentType;
  onSelect: (episode: EpisodeListItem) => void;
  queueEnabled: boolean;
  isQueued: boolean;
  onToggleQueue: (episode: EpisodeListItem) => void;
  queueActionLabel: string;
}) {
  const meta = [formatDuration(episode.durationSec), formatDate(episode.publishedAt)]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} activeOpacity={0.7} onPress={() => onSelect(episode)}>
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
      {queueEnabled && (
        <TouchableOpacity
          style={styles.queueBtn}
          activeOpacity={0.7}
          hitSlop={8}
          onPress={() => onToggleQueue(episode)}
          accessibilityRole="button"
          accessibilityLabel={queueActionLabel}
        >
          <MaterialCommunityIcons
            name={isQueued ? 'check-circle' : 'plus-circle-outline'}
            size={24}
            color={isQueued ? theme.colors.primary : theme.colors.textSecondary}
          />
        </TouchableOpacity>
      )}
    </View>
  );
});

/** Failed-request state (distinct from empty) with a Retry affordance. */
const ErrorState = memo(function ErrorState({
  theme,
  message,
  retryLabel,
  onRetry,
}: {
  theme: AgoraTheme;
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.stateBox}>
      <MaterialCommunityIcons name="wifi-off" size={32} color={theme.colors.textSecondary} />
      <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>{message}</Text>
      <TouchableOpacity
        style={[styles.retryBtn, { borderColor: theme.colors.border }]}
        activeOpacity={0.7}
        onPress={onRetry}
      >
        <MaterialCommunityIcons name="refresh" size={16} color={theme.colors.primary} />
        <Text style={[styles.retryText, { color: theme.colors.primary }]}>{retryLabel}</Text>
      </TouchableOpacity>
    </View>
  );
});

/**
 * Self-contained two-level podcast picker for the live-room stream setup. Level 1
 * is a debounced Syra show search; tapping a show drills into Level 2, its episode
 * list. Tapping an episode reports `(syraPodcastId, episodeId)` to the parent — the
 * picker owns NO room/stream logic. Ships inside agora-shared, so it depends only
 * on `useAgoraConfig()` injection and never imports from a host app (`@/`).
 *
 * UX affordances (all backend-field-free): a host copyright disclaimer, an honest
 * error+Retry state distinct from empty results, a one-tap "stream my pinned
 * podcast" quick-start row (when the host exposes `getPinnedPodcast`), and an
 * "Open in Syra" deep link on the episode-list header.
 */
export function PodcastStreamPicker({ onSelectEpisode, onStartQueue }: PodcastStreamPickerProps) {
  const { useTheme, agoraService, AvatarComponent, toast, t, getPinnedPodcast } = useAgoraConfig();
  const theme = useTheme();

  const tr = useCallback<TranslateFn>(
    (key) => (t ? t(key) : DEFAULT_STRINGS[key] ?? key),
    [t],
  );

  // Up-next queue: only offered when the host wired the multi-episode start.
  const queueEnabled = !!onStartQueue;
  const [queued, setQueued] = useState<PodcastQueueSelection[]>([]);
  const queuedIds = useMemo(() => new Set(queued.map((q) => q.episodeId)), [queued]);

  // Level 1 — show search
  const [query, setQuery] = useState('');
  const [shows, setShows] = useState<PodcastResult[]>([]);
  const [showsNextOffset, setShowsNextOffset] = useState(0);
  const [showsHasMore, setShowsHasMore] = useState(false);
  const [showsLoading, setShowsLoading] = useState(false);
  const [showsLoadingMore, setShowsLoadingMore] = useState(false);
  const [showsError, setShowsError] = useState(false);
  const showsSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pinned-podcast quick-start (only when the host exposes profile media).
  const [pinnedPodcast, setPinnedPodcast] = useState<PinnedPodcast | null>(null);

  // Level 2 — episode list
  const [selectedShow, setSelectedShow] = useState<PodcastResult | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [episodesNextOffset, setEpisodesNextOffset] = useState(0);
  const [episodesHasMore, setEpisodesHasMore] = useState(false);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesLoadingMore, setEpisodesLoadingMore] = useState(false);
  const [episodesError, setEpisodesError] = useState(false);
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
        setShowsError(false);
        return;
      }
      const seq = offset === 0 ? (showsSeqRef.current += 1) : showsSeqRef.current;
      if (offset === 0) {
        setShowsLoading(true);
        setShowsError(false);
      } else {
        setShowsLoadingMore(true);
      }

      const result = await agoraService.searchPodcasts(trimmed, offset);
      if (seq !== showsSeqRef.current) return; // superseded by a newer query

      if (!result.ok) {
        // Only replace the list on a fresh search; a load-more failure keeps the
        // rows the host already has and simply stops paginating.
        if (offset === 0) {
          setShows([]);
          setShowsError(true);
        }
        setShowsHasMore(false);
        setShowsLoading(false);
        setShowsLoadingMore(false);
        return;
      }

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
      if (text.trim()) {
        setShowsLoading(true);
        setShowsError(false);
      }
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
      if (offset === 0) {
        setEpisodesLoading(true);
        setEpisodesError(false);
      } else {
        setEpisodesLoadingMore(true);
      }

      const result = await agoraService.getPodcastEpisodes(syraPodcastId, offset);
      if (seq !== episodesSeqRef.current) return; // superseded by a newer show

      if (!result.ok) {
        if (offset === 0) {
          setEpisodes([]);
          setEpisodesError(true);
        }
        setEpisodesHasMore(false);
        setEpisodesLoading(false);
        setEpisodesLoadingMore(false);
        return;
      }

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
      setEpisodesError(false);
      loadEpisodes(show.syraPodcastId, 0);
    },
    [loadEpisodes],
  );

  const handleSelectPinned = useCallback(() => {
    if (!pinnedPodcast) return;
    handleSelectShow({
      syraPodcastId: pinnedPodcast.syraPodcastId,
      title: pinnedPodcast.title ?? tr('agora.podcastStream.pinnedTitle'),
      artworkUrl: pinnedPodcast.artworkUrl,
    });
  }, [pinnedPodcast, handleSelectShow, tr]);

  const handleBack = useCallback(() => {
    episodesSeqRef.current += 1;
    setSelectedShow(null);
    setEpisodes([]);
    setEpisodesHasMore(false);
    setEpisodesNextOffset(0);
    setEpisodesLoading(false);
    setEpisodesLoadingMore(false);
    setEpisodesError(false);
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

  // Toggle an episode in/out of the local up-next queue. Items keep their own
  // show id, so a host can queue across multiple shows before launching.
  const handleToggleQueue = useCallback(
    (episode: EpisodeListItem) => {
      if (!selectedShow) return;
      const showId = selectedShow.syraPodcastId;
      setQueued((prev) =>
        prev.some((q) => q.episodeId === episode.episodeId)
          ? prev.filter((q) => q.episodeId !== episode.episodeId)
          : [...prev, { syraPodcastId: showId, episodeId: episode.episodeId }],
      );
    },
    [selectedShow],
  );

  const handleClearQueue = useCallback(() => setQueued([]), []);

  const handleStartQueue = useCallback(() => {
    if (queued.length === 0) return;
    onStartQueue?.(queued);
    setQueued([]);
  }, [queued, onStartQueue]);

  const handleOpenInSyra = useCallback(() => {
    if (!selectedShow) return;
    Linking.openURL(`${SYRA_WEB_BASE_URL}/podcasts/${selectedShow.syraPodcastId}`).catch(() =>
      toast.error(tr('agora.podcastStream.openFailed')),
    );
  }, [selectedShow, toast, tr]);

  // Resolve the viewer's pinned podcast once on mount (host-provided; optional).
  useEffect(() => {
    if (!getPinnedPodcast) return;
    let cancelled = false;
    getPinnedPodcast().then(
      (podcast) => {
        if (!cancelled) setPinnedPodcast(podcast);
      },
      () => {
        if (!cancelled) setPinnedPodcast(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [getPinnedPodcast]);

  // Cancel any pending debounced search when the picker unmounts.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const hasQuery = query.trim().length > 0;
  const showQueueFooter = queueEnabled && queued.length > 0;
  const listContentStyle = showQueueFooter
    ? [styles.listContent, styles.listContentWithFooter]
    : styles.listContent;

  // Floats over the bottom of either level; queued items persist across shows
  // so the host can review/launch after adding from multiple shows.
  const queueFooter = showQueueFooter ? (
    <View style={[styles.queueFooter, { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border }]}>
      <TouchableOpacity
        style={styles.queueClearBtn}
        activeOpacity={0.7}
        hitSlop={8}
        onPress={handleClearQueue}
        accessibilityRole="button"
      >
        <Text style={[styles.queueClearText, { color: theme.colors.textSecondary }]}>
          {tr('agora.podcastStream.clearQueue')}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.queuePlayBtn, { backgroundColor: theme.colors.primary }]}
        activeOpacity={0.85}
        onPress={handleStartQueue}
        accessibilityRole="button"
      >
        <MaterialCommunityIcons name="play" size={18} color="#FFFFFF" />
        <Text style={styles.queuePlayText}>
          {tr('agora.podcastStream.playQueue')} ({queued.length})
        </Text>
      </TouchableOpacity>
    </View>
  ) : null;

  if (selectedShow) {
    return (
      <View style={styles.container}>
        <View style={styles.backHeader}>
          <TouchableOpacity
            style={styles.backHeaderMain}
            activeOpacity={0.7}
            onPress={handleBack}
            hitSlop={8}
          >
            <MaterialCommunityIcons name="chevron-left" size={24} color={theme.colors.text} />
            <Text style={[styles.backTitle, { color: theme.colors.text }]} numberOfLines={1}>
              {selectedShow.title}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.openBtn}
            activeOpacity={0.7}
            onPress={handleOpenInSyra}
            hitSlop={8}
            accessibilityRole="link"
            accessibilityLabel={tr('agora.podcastStream.openInSyra')}
          >
            <MaterialCommunityIcons name="open-in-new" size={20} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {episodesLoading ? (
          <View style={styles.stateBox}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        ) : episodesError ? (
          <ErrorState
            theme={theme}
            message={tr('agora.podcastStream.errorEpisodes')}
            retryLabel={tr('agora.podcastStream.retry')}
            onRetry={() => loadEpisodes(selectedShow.syraPodcastId, 0)}
          />
        ) : episodes.length === 0 ? (
          <View style={styles.stateBox}>
            <MaterialCommunityIcons name="playlist-remove" size={32} color={theme.colors.textSecondary} />
            <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>
              {tr('agora.podcastStream.emptyEpisodes')}
            </Text>
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
                queueEnabled={queueEnabled}
                isQueued={queuedIds.has(item.episodeId)}
                onToggleQueue={handleToggleQueue}
                queueActionLabel={tr(
                  queuedIds.has(item.episodeId)
                    ? 'agora.podcastStream.removeFromQueue'
                    : 'agora.podcastStream.addToQueue',
                )}
              />
            )}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={handleEpisodesEndReached}
            onEndReachedThreshold={0.4}
            contentContainerStyle={listContentStyle}
            ListFooterComponent={
              episodesLoadingMore ? (
                <View style={styles.footerLoader}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                </View>
              ) : null
            }
          />
        )}
        {queueFooter}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.disclaimer}>
        <MaterialCommunityIcons name="shield-alert-outline" size={15} color={theme.colors.textSecondary} />
        <Text style={[styles.disclaimerText, { color: theme.colors.textSecondary }]}>
          {tr('agora.podcastStream.disclaimer')}
        </Text>
      </View>

      <View style={styles.searchWrap}>
        <View style={[styles.searchRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
          <MaterialCommunityIcons name="magnify" size={18} color={theme.colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: theme.colors.text }]}
            placeholder={tr('agora.podcastStream.searchPlaceholder')}
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
        <View>
          {pinnedPodcast && (
            <TouchableOpacity
              style={[styles.pinnedRow, { backgroundColor: `${theme.colors.primary}14`, borderColor: theme.colors.border }]}
              activeOpacity={0.7}
              onPress={handleSelectPinned}
            >
              <View style={[styles.pinnedIcon, { backgroundColor: `${theme.colors.primary}22` }]}>
                <MaterialCommunityIcons name="flash" size={20} color={theme.colors.primary} />
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
                  {tr('agora.podcastStream.pinnedTitle')}
                </Text>
                {!!pinnedPodcast.title && (
                  <Text style={[styles.rowSubtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                    {pinnedPodcast.title}
                  </Text>
                )}
              </View>
              <MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}
          <View style={styles.stateBox}>
            <MaterialCommunityIcons name="podcast" size={32} color={theme.colors.textSecondary} />
            <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>
              {tr('agora.podcastStream.searchHint')}
            </Text>
          </View>
        </View>
      ) : showsError ? (
        <ErrorState
          theme={theme}
          message={tr('agora.podcastStream.errorShows')}
          retryLabel={tr('agora.podcastStream.retry')}
          onRetry={() => runSearch(query, 0)}
        />
      ) : showsLoading ? (
        <View style={styles.stateBox}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      ) : shows.length === 0 ? (
        <View style={styles.stateBox}>
          <MaterialCommunityIcons name="magnify-close" size={32} color={theme.colors.textSecondary} />
          <Text style={[styles.stateText, { color: theme.colors.textSecondary }]}>
            {tr('agora.podcastStream.emptyShows')}
          </Text>
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
          contentContainerStyle={listContentStyle}
          ListFooterComponent={
            showsLoadingMore ? (
              <View style={styles.footerLoader}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </View>
            ) : null
          }
        />
      )}
      {queueFooter}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  disclaimer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  disclaimerText: { flex: 1, fontSize: 12, lineHeight: 16 },
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
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
  },
  backHeaderMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  backTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  openBtn: { padding: 6, marginLeft: 4 },
  listContent: { paddingBottom: 24 },
  listContentWithFooter: { paddingBottom: 88 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  queueBtn: { padding: 4 },
  pinnedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 12,
  },
  pinnedIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
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
  stateText: { fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 4,
  },
  retryText: { fontSize: 14, fontWeight: '600' },
  footerLoader: { paddingVertical: 16 },
  queueFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 1,
  },
  queueClearBtn: { paddingVertical: 8, paddingHorizontal: 4 },
  queueClearText: { fontSize: 14, fontWeight: '600' },
  queuePlayBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  queuePlayText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
});
