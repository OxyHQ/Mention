import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
import { SafeAreaView } from "@/lib/SafeAreaViewInterop";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getNormalizedUserHandle } from "@oxyhq/core";
import { useSafeBack } from "@/hooks/useSafeBack";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/Header";
import { IconButton } from "@/components/ui/Button";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useTheme } from "@oxyhq/bloom/theme";
import {
    searchService,
    SEARCH_OPERATORS,
    type SearchFeedResult,
    type SearchHashtagResult,
    type SearchListResult,
    type SearchPostResult,
    type SearchUserResult,
} from "@/services/searchService";
import { Loading } from "@oxyhq/bloom/loading";
import { FlashList } from "@shopify/flash-list";
import AnimatedTabBar from "@/components/common/AnimatedTabBar";
import PostItem from "@/components/Feed/PostItem";
import { Search } from "@/assets/icons/search-icon";
import SEO from "@/components/SEO";
import { ProfileCard, ProfileCardSkeletonList, type ProfileCardData } from "@/components/ProfileCard";
import { FeedCard, type FeedCardData } from "@/components/FeedCard";
import { ListCard, type ListCardData } from "@/components/ListCard";
import { ExternalActorFollowButton } from "@/components/search/ExternalActorFollowButton";
import { useExternalActorResolve } from "@/hooks/useExternalActorResolve";
import type { ExternalActorResolution } from "@/services/feedService";
import { EmptyState } from "@/components/common/EmptyState";
import { Error } from "@/components/Error";
import { TrendItemRow } from "@/components/trending/TrendItemRow";
import { useTrendsStore } from "@/store/trendsStore";
import { useTrendNavigation } from "@/hooks/useTrendNavigation";
import type { Trend } from "@/interfaces/Trend";
import { formatCompactNumber } from "@/utils/formatNumber";
import { logger } from "@/lib/logger";

type ResultTab = "posts" | "users" | "feeds" | "hashtags" | "lists" | "saved";
type SearchTab = "all" | ResultTab;

type LocalSearchResults = {
    posts: SearchPostResult[];
    users: SearchUserResult[];
    feeds: SearchFeedResult[];
    hashtags: SearchHashtagResult[];
    lists: SearchListResult[];
    saved: SearchPostResult[];
};

const EMPTY_RESULTS: LocalSearchResults = {
    posts: [],
    users: [],
    feeds: [],
    hashtags: [],
    lists: [],
    saved: [],
};

const RESULT_TABS: ResultTab[] = ["posts", "users", "feeds", "hashtags", "lists", "saved"];
const SEARCH_TABS: SearchTab[] = ["all", ...RESULT_TABS];

function isSearchTab(value: string): value is SearchTab {
    return (SEARCH_TABS as string[]).includes(value);
}

/** Debounce before a keystroke turns into a request. */
const SEARCH_DEBOUNCE_MS = 500;

/** Cap on the in-memory `${tab}-${query}` result cache. */
const MAX_CACHE_SIZE = 50;

/** Placeholder rows painted while the people tab searches. */
const SKELETON_ROW_COUNT = 8;

/** Trending rows offered on the idle (no query) screen. */
const MAX_IDLE_TRENDS = 5;

/** The search history lives in Storage; React Query owns the in-memory copy. */
const SEARCH_HISTORY_QUERY_KEY = ["search", "history"] as const;

/**
 * One flattened, virtualized row model so the WHOLE screen — idle state and
 * results alike — renders through a single FlashList. The scroll container never
 * swaps between states (no scroll/keyboard reset on the first keystroke), and
 * off-screen rows (notably the heavy <PostItem> cards) stay unmounted. `kind`
 * doubles as the FlashList recycle bucket, so a post card is never recycled into
 * a profile row.
 */
type SearchRow =
    | { kind: "sectionHeader"; key: string; title: string; action?: { label: string; onPress: () => void } }
    | { kind: "recent"; key: string; term: string }
    | { kind: "trend"; key: string; trend: Trend }
    | { kind: "trendsLoading"; key: string }
    | { kind: "trendsError"; key: string }
    | { kind: "operators"; key: string }
    | { kind: "user"; key: string; profile: ProfileCardData }
    | { kind: "externalUser"; key: string; profile: ProfileCardData; actor: ExternalActorResolution }
    | { kind: "post"; key: string; post: SearchPostResult }
    | { kind: "feed"; key: string; feed: SearchFeedResult }
    | { kind: "hashtag"; key: string; hashtag: SearchHashtagResult }
    | { kind: "list"; key: string; list: SearchListResult };

/** Drop the oldest entries once the result cache outgrows its cap. */
function pruneCache(cache: Record<string, LocalSearchResults>): Record<string, LocalSearchResults> {
    const entries = Object.entries(cache);
    if (entries.length <= MAX_CACHE_SIZE) return cache;
    return Object.fromEntries(entries.slice(-MAX_CACHE_SIZE));
}

function toProfileCardData(user: SearchUserResult): ProfileCardData | null {
    const username = user.username || user.handle || "";
    if (!username) return null;
    return {
        id: String(user.id || username),
        username,
        name: user.name,
        avatar: user.avatar || undefined,
        verified: Boolean(user.verified),
        description: user.bio,
        isFederated: user.isFederated || user.type === "federated",
        instance: user.instance || user.federation?.domain,
    };
}

/**
 * A cross-network actor resolved by `GET /federation/resolve`, as a normal people
 * row. Its handle is already network-qualified (`user@domain` for ActivityPub,
 * the DNS handle for atproto), so it carries no `instance`: the handle passes
 * through `getNormalizedUserHandle` unchanged, which is exactly the `/@handle`
 * the federated profile screen resolves.
 *
 * The id is the Oxy user once the actor has been minted there, and the protocol
 * id (actor URI / DID) until then — the row's only id-keyed control is its follow
 * button, which dispatches on that very distinction.
 */
function externalActorToProfileCardData(actor: ExternalActorResolution): ProfileCardData {
    return {
        id: actor.oxyUserId ?? actor.externalId,
        username: actor.handle,
        name: { displayName: actor.displayName },
        avatar: actor.avatarUrl,
        isFederated: true,
    };
}

/**
 * The handles a people result can be recognized by when deduping the resolved
 * cross-network actor against it.
 *
 * Oxy stores a federated account under `local@instance` — `usatoday@flipboard.com`
 * (ActivityPub) or `alice.bsky.social@bsky.social` (atproto) — while a resolve
 * returns the network-native handle: `usatoday@flipboard.com` for ActivityPub, the
 * bare `alice.bsky.social` for atproto. So a federated row also answers to its
 * handle's local part; a local row never does (its username is not an address).
 */
function profileIdentityKeys(profile: ProfileCardData): string[] {
    const handle = getNormalizedUserHandle(profile)?.toLowerCase();
    if (!handle) return [];
    const at = handle.indexOf("@");
    if (!profile.isFederated || at <= 0) return [handle];
    return [handle, handle.slice(0, at)];
}

/** Whether a people result IS the resolved cross-network actor. */
function isSameActor(profile: ProfileCardData, actor: ExternalActorResolution): boolean {
    if (actor.oxyUserId && profile.id === actor.oxyUserId) return true;
    const actorHandle = actor.handle.trim().replace(/^@+/, "").toLowerCase();
    return actorHandle.length > 0 && profileIdentityKeys(profile).includes(actorHandle);
}

function toFeedCardData(feed: SearchFeedResult): FeedCardData | null {
    const id = String(feed.id || feed._id || "");
    if (!id) return null;
    const owner = feed.creator || feed.owner;
    return {
        id,
        uri: feed.uri || `feed:${id}`,
        displayName: feed.title || feed.displayName || "Untitled Feed",
        description: feed.description,
        avatar: feed.avatar,
        creator: owner
            ? {
                username: owner.username || owner.handle || "",
                displayName: owner.name?.displayName,
                avatar: owner.avatar,
            }
            : undefined,
        likeCount: feed.likeCount,
        subscriberCount: feed.subscriberCount || feed.memberCount,
    };
}

function toListCardData(list: SearchListResult): ListCardData | null {
    const id = String(list.id || list._id || "");
    if (!id) return null;
    const owner = list.owner || list.createdBy || list.creator;
    return {
        id,
        uri: list.uri || `list:${id}`,
        name: list.name || list.title || "Untitled List",
        description: list.description,
        avatar: list.avatar,
        creator: owner
            ? {
                username: owner.username || owner.handle || "",
                displayName: owner.name?.displayName,
                avatar: owner.avatar,
            }
            : undefined,
        purpose: list.purpose === "modlist" ? "modlist" : "curatelist",
        itemCount: list.itemCount || list.memberCount || 0,
    };
}

export default function SearchIndex() {
    const { t } = useTranslation();
    const theme = useTheme();
    const safeBack = useSafeBack();
    const queryClient = useQueryClient();
    const params = useLocalSearchParams();
    const urlQuery = (params.q as string) || "";

    const [query, setQuery] = useState(urlQuery);
    const [activeTab, setActiveTab] = useState<SearchTab>("all");
    const [loading, setLoading] = useState(false);
    const [searchFailed, setSearchFailed] = useState(false);
    const [results, setResults] = useState<LocalSearchResults>(EMPTY_RESULTS);

    // The result cache is never rendered directly — keeping it in a ref (instead
    // of state) avoids a re-render per cache write and the state→ref sync effect
    // it used to need.
    const resultsCacheRef = useRef<Record<string, LocalSearchResults>>({});
    // Monotonic token so a slow response from an abandoned query can never
    // overwrite the results of a newer one.
    const requestIdRef = useRef(0);
    // Cache keys with a request already in flight. An explicit submit (or a tab
    // press) searches immediately while the debounce timer for the same keystroke
    // is still pending — without this guard both would fire the same request.
    const inFlightRef = useRef<Set<string>>(new Set());
    const searchInputRef = useRef<TextInput>(null);

    // A `/search?q=…` deep link can change while this screen stays mounted.
    // Adjusting state during render (instead of an Effect) keeps the input in
    // lockstep with the URL without an extra render pass.
    const [syncedUrlQuery, setSyncedUrlQuery] = useState(urlQuery);
    if (urlQuery !== syncedUrlQuery) {
        setSyncedUrlQuery(urlQuery);
        setQuery(urlQuery);
    }

    // --- Search history (Storage-backed, cached by React Query) ---
    const { data: searchHistory = [] } = useQuery({
        queryKey: SEARCH_HISTORY_QUERY_KEY,
        queryFn: () => searchService.getSearchHistory(),
        staleTime: Infinity,
    });

    const setSearchHistory = useCallback(
        (history: string[]) => {
            queryClient.setQueryData<string[]>(SEARCH_HISTORY_QUERY_KEY, history);
        },
        [queryClient],
    );

    // History records what the user MEANT to search — an explicit submit or an
    // opened result — never the partial words a debounced keystroke produced.
    const commitToHistory = useCallback(
        (term: string) => {
            const trimmed = term.trim();
            if (!trimmed) return;
            searchService
                .addToSearchHistory(trimmed)
                .then(setSearchHistory)
                .catch((error: unknown) => logger.warn("Failed to save search history", { error }));
        },
        [setSearchHistory],
    );

    const commitCurrentQuery = useCallback(() => {
        commitToHistory(query);
    }, [commitToHistory, query]);

    // --- Trending (idle state) ---
    const trends = useTrendsStore((state) => state.trends);
    const hiddenTrendIds = useTrendsStore((state) => state.hiddenTrendIds);
    const trendsLoading = useTrendsStore((state) => state.isLoading);
    const trendsFetched = useTrendsStore((state) => state.hasFetched);
    const trendsError = useTrendsStore((state) => state.error);
    const fetchTrends = useTrendsStore((state) => state.fetchTrends);
    const startTrendsPolling = useTrendsStore((state) => state.startPolling);
    const stopTrendsPolling = useTrendsStore((state) => state.stopPolling);
    const { navigateToTrend } = useTrendNavigation();

    // Subscribing to the shared trends poller is external-system sync — the one
    // thing Effects are for. The store ref-counts subscribers.
    useEffect(() => {
        startTrendsPolling();
        return () => stopTrendsPolling();
    }, [startTrendsPolling, stopTrendsPolling]);

    const visibleTrends = useMemo(
        () => trends.filter((trend) => !hiddenTrendIds.includes(trend.id)).slice(0, MAX_IDLE_TRENDS),
        [trends, hiddenTrendIds],
    );

    // Cross-network resolve — when the query looks like a remote handle
    // (`@user@host`, `user.bsky.social`, `did:`, `at://`), resolve it to an
    // external actor (Mastodon / Bluesky) and merge it into the people results
    // below as one more row. Local `@username` queries never trigger this and stay
    // entirely on the Oxy people search. A miss is a quiet `null` — no extra row.
    const externalActor = useExternalActorResolve(query);

    const writeCache = useCallback((key: string, value: LocalSearchResults) => {
        resultsCacheRef.current = pruneCache({ ...resultsCacheRef.current, [key]: value });
    }, []);

    const performSearch = useCallback(
        async (rawQuery: string, tab: SearchTab) => {
            const searchQuery = rawQuery.trim();
            if (!searchQuery) return;

            const cacheKey = `${tab}-${searchQuery}`;
            const cached = resultsCacheRef.current[cacheKey];
            if (cached) {
                requestIdRef.current += 1;
                setResults(cached);
                setSearchFailed(false);
                setLoading(false);
                return;
            }

            // A single-category tab can be served from the "all" results already
            // in the cache — no request needed.
            if (tab !== "all") {
                const allCached = resultsCacheRef.current[`all-${searchQuery}`];
                if (allCached) {
                    const tabResults: LocalSearchResults = { ...EMPTY_RESULTS, [tab]: allCached[tab] };
                    writeCache(cacheKey, tabResults);
                    requestIdRef.current += 1;
                    setResults(tabResults);
                    setSearchFailed(false);
                    setLoading(false);
                    return;
                }
            }

            if (inFlightRef.current.has(cacheKey)) return;

            const requestId = (requestIdRef.current += 1);
            const isStale = () => requestId !== requestIdRef.current;

            inFlightRef.current.add(cacheKey);
            setLoading(true);
            setSearchFailed(false);
            try {
                let newResults: LocalSearchResults;

                if (tab === "all") {
                    const allResults = await searchService.searchAll(searchQuery);
                    newResults = {
                        posts: allResults.posts || [],
                        users: allResults.users || [],
                        feeds: allResults.feeds || [],
                        hashtags: allResults.hashtags || [],
                        lists: allResults.lists || [],
                        saved: allResults.saved || [],
                    };

                    writeCache(cacheKey, newResults);
                    // Pre-populate the single-category caches from the same payload.
                    for (const resultTab of RESULT_TABS) {
                        const tabCacheKey = `${resultTab}-${searchQuery}`;
                        if (!resultsCacheRef.current[tabCacheKey]) {
                            writeCache(tabCacheKey, { ...EMPTY_RESULTS, [resultTab]: newResults[resultTab] });
                        }
                    }
                } else {
                    const fetchMap = {
                        posts: () => searchService.searchPosts(searchQuery),
                        users: () => searchService.searchUsers(searchQuery),
                        feeds: () => searchService.searchFeeds(searchQuery),
                        hashtags: () => searchService.searchHashtags(searchQuery),
                        lists: () => searchService.searchLists(searchQuery),
                        saved: () => searchService.searchSaved(searchQuery),
                    } satisfies Record<ResultTab, () => Promise<LocalSearchResults[ResultTab]>>;

                    const data = await fetchMap[tab]();
                    newResults = { ...EMPTY_RESULTS, [tab]: data };
                    writeCache(cacheKey, newResults);
                }

                if (isStale()) return;
                setResults(newResults);
            } catch (error) {
                logger.warn("Search failed", { error, tab });
                if (isStale()) return;
                setResults(EMPTY_RESULTS);
                setSearchFailed(true);
            } finally {
                inFlightRef.current.delete(cacheKey);
                if (!isStale()) setLoading(false);
            }
        },
        [writeCache],
    );

    // Debounced search. Subscribing a changing input to a timer is the idiomatic
    // place for an Effect; an explicit submit bypasses it via `handleSubmit`.
    useEffect(() => {
        const searchQuery = query.trim();
        if (!searchQuery) return;
        const timeoutId = setTimeout(() => {
            void performSearch(searchQuery, activeTab);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timeoutId);
    }, [query, activeTab, performSearch]);

    const resetResults = useCallback(() => {
        requestIdRef.current += 1;
        setResults(EMPTY_RESULTS);
        setSearchFailed(false);
        setLoading(false);
    }, []);

    const handleQueryChange = useCallback(
        (text: string) => {
            setQuery(text);
            // Clearing the box returns the screen to its idle state immediately —
            // no stale results, no lingering error, no spinner.
            if (!text.trim()) resetResults();
        },
        [resetResults],
    );

    const clearSearch = useCallback(() => {
        setQuery("");
        resetResults();
        searchInputRef.current?.focus();
    }, [resetResults]);

    const handleSubmit = useCallback(() => {
        const searchQuery = query.trim();
        if (!searchQuery) return;
        commitToHistory(searchQuery);
        void performSearch(searchQuery, activeTab);
    }, [query, activeTab, commitToHistory, performSearch]);

    const retrySearch = useCallback(() => {
        void performSearch(query, activeTab);
    }, [performSearch, query, activeTab]);

    // Switching tabs searches straight away instead of waiting out the debounce —
    // a tab whose results are already cached (every tab is, right after an "all"
    // search) swaps in with no request at all.
    const handleTabPress = useCallback(
        (id: string) => {
            if (!isSearchTab(id)) return;
            setActiveTab(id);
            const searchQuery = query.trim();
            if (searchQuery) void performSearch(searchQuery, id);
        },
        [query, performSearch],
    );

    // --- Idle-state handlers ---
    const handleRecentPress = useCallback(
        (term: string) => {
            setQuery(term);
            commitToHistory(term);
            void performSearch(term, activeTab);
        },
        [commitToHistory, performSearch, activeTab],
    );

    const handleRemoveRecent = useCallback(
        async (term: string) => {
            setSearchHistory(await searchService.removeFromSearchHistory(term));
        },
        [setSearchHistory],
    );

    const handleClearHistory = useCallback(async () => {
        await searchService.clearSearchHistory();
        setSearchHistory([]);
    }, [setSearchHistory]);

    const handleOperatorPress = useCallback((operator: string) => {
        const [prefix] = operator.split(":");
        setQuery(`${prefix}:`);
        searchInputRef.current?.focus();
    }, []);

    // --- Result handlers (opening a result commits the query to history) ---
    const handleOpenProfile = useCallback(
        (profile: ProfileCardData) => {
            commitCurrentQuery();
            const handle = getNormalizedUserHandle(profile);
            if (handle) router.push(`/@${handle}`);
        },
        [commitCurrentQuery],
    );

    const handleOpenFeed = useCallback(
        (feedId: string) => {
            commitCurrentQuery();
            router.push(`/feeds/${feedId}`);
        },
        [commitCurrentQuery],
    );

    const handleOpenList = useCallback(
        (listId: string) => {
            commitCurrentQuery();
            router.push(`/lists/${listId}`);
        },
        [commitCurrentQuery],
    );

    const handleOpenHashtag = useCallback(
        (tag: string) => {
            commitCurrentQuery();
            router.push(`/hashtag/${encodeURIComponent(tag)}`);
        },
        [commitCurrentQuery],
    );

    const tabs = useMemo(
        () => [
            { id: "all", label: t("search.tabs.all", "All") },
            { id: "posts", label: t("search.tabs.posts", "Posts") },
            { id: "users", label: t("search.tabs.users", "Users") },
            { id: "feeds", label: t("search.tabs.feeds", "Feeds") },
            { id: "hashtags", label: t("search.tabs.hashtags", "Hashtags") },
            { id: "lists", label: t("search.tabs.lists", "Lists") },
            { id: "saved", label: t("search.tabs.saved", "Saved") },
        ],
        [t],
    );

    const isIdle = !query.trim();

    // Idle rows: recent searches, then trending, then the (secondary) operator
    // chips. Empty while a query is active.
    const idleRows = useMemo<SearchRow[]>(() => {
        if (!isIdle) return [];
        const rows: SearchRow[] = [];

        if (searchHistory.length > 0) {
            rows.push({
                kind: "sectionHeader",
                key: "header-recent",
                title: t("search.recentSearches", "Recent searches"),
                action: { label: t("common.clearAll", "Clear all"), onPress: () => void handleClearHistory() },
            });
            for (const term of searchHistory) {
                rows.push({ kind: "recent", key: `recent-${term}`, term });
            }
        }

        const showTrendsSection = visibleTrends.length > 0 || !trendsFetched || Boolean(trendsError);
        if (showTrendsSection) {
            rows.push({ kind: "sectionHeader", key: "header-trending", title: t("Trending") });
            if (visibleTrends.length > 0) {
                for (const trend of visibleTrends) {
                    rows.push({ kind: "trend", key: `trend-${trend.id}`, trend });
                }
            } else if (trendsError) {
                rows.push({ kind: "trendsError", key: "trends-error" });
            } else if (trendsLoading || !trendsFetched) {
                rows.push({ kind: "trendsLoading", key: "trends-loading" });
            }
        }

        rows.push({ kind: "operators", key: "operators" });
        return rows;
    }, [isIdle, searchHistory, visibleTrends, trendsFetched, trendsLoading, trendsError, t, handleClearHistory]);

    // Result rows: one section per non-empty category on the "all" tab (headers
    // included), a flat list on a single-category tab. Empty while loading so the
    // list's empty slot can own the spinner.
    const resultRows = useMemo<SearchRow[]>(() => {
        if (isIdle || loading || searchFailed) return [];
        const rows: SearchRow[] = [];
        const isAll = activeTab === "all";

        const pushSection = (visible: boolean, title: string, sectionRows: SearchRow[]) => {
            if (!visible || sectionRows.length === 0) return;
            if (isAll) rows.push({ kind: "sectionHeader", key: `header-${title}`, title });
            rows.push(...sectionRows);
        };

        // People — Oxy's own results, which ALREADY include the federated accounts
        // it knows about.
        const profiles = results.users
            .map(toProfileCardData)
            .filter((profile): profile is ProfileCardData => profile !== null);
        const peopleRows = profiles.map(
            (profile): SearchRow => ({ kind: "user", key: `user-${profile.id}`, profile }),
        );

        // …plus the account a live cross-network lookup resolved, which Oxy cannot
        // return until it has been minted there. It is an exact-handle match, so it
        // leads the people results — unless Oxy already returned that same account,
        // whose row is the richer local record and wins.
        if (externalActor && !profiles.some((profile) => isSameActor(profile, externalActor))) {
            peopleRows.unshift({
                kind: "externalUser",
                key: `external-${externalActor.externalId}`,
                profile: externalActorToProfileCardData(externalActor),
                actor: externalActor,
            });
        }

        pushSection(isAll || activeTab === "users", t("search.sections.users", "People"), peopleRows);
        pushSection(
            isAll || activeTab === "posts",
            t("search.sections.posts", "Posts"),
            results.posts.map((post): SearchRow => ({ kind: "post", key: `post-${post.id}`, post })),
        );
        pushSection(
            isAll || activeTab === "feeds",
            t("search.sections.feeds", "Feeds"),
            results.feeds.map((feed): SearchRow => ({ kind: "feed", key: `feed-${feed.id || feed._id}`, feed })),
        );
        pushSection(
            isAll || activeTab === "hashtags",
            t("search.sections.hashtags", "Hashtags"),
            results.hashtags.map((hashtag): SearchRow => ({ kind: "hashtag", key: `hashtag-${hashtag.tag}`, hashtag })),
        );
        pushSection(
            isAll || activeTab === "lists",
            t("search.sections.lists", "Lists"),
            results.lists.map((list): SearchRow => ({ kind: "list", key: `list-${list.id || list._id}`, list })),
        );
        pushSection(
            isAll || activeTab === "saved",
            t("search.sections.saved", "Saved"),
            results.saved.map((post): SearchRow => ({ kind: "post", key: `saved-${post.id || post._id}`, post })),
        );

        return rows;
    }, [isIdle, loading, searchFailed, activeTab, results, externalActor, t]);

    const rows = isIdle ? idleRows : resultRows;

    const renderRow = useCallback(
        ({ item }: { item: SearchRow }): React.ReactElement | null => {
            switch (item.kind) {
                case "sectionHeader":
                    return (
                        <View className="w-full flex-row items-center justify-between px-3 pt-4 pb-2">
                            <Text className="text-lg font-bold text-foreground">{item.title}</Text>
                            {item.action ? (
                                <TouchableOpacity onPress={item.action.onPress} hitSlop={8}>
                                    <Text className="text-sm font-semibold text-primary">{item.action.label}</Text>
                                </TouchableOpacity>
                            ) : null}
                        </View>
                    );

                case "recent":
                    return (
                        <TouchableOpacity
                            className="w-full flex-row items-center justify-between px-3 py-3 border-b border-border"
                            onPress={() => handleRecentPress(item.term)}
                            accessibilityRole="button"
                        >
                            <View className="flex-1 flex-row items-center gap-3">
                                <Ionicons name="time-outline" size={18} color={theme.colors.textSecondary} />
                                <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                                    {item.term}
                                </Text>
                            </View>
                            <TouchableOpacity
                                onPress={() => void handleRemoveRecent(item.term)}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t("search.removeRecent", "Remove from recent searches")}
                            >
                                <Ionicons name="close" size={16} color={theme.colors.textTertiary} />
                            </TouchableOpacity>
                        </TouchableOpacity>
                    );

                case "trend":
                    return (
                        <View className="w-full px-3 border-b border-border">
                            <TrendItemRow trend={item.trend} onPress={navigateToTrend} size="large" />
                        </View>
                    );

                case "trendsLoading":
                    return (
                        <View className="w-full items-center justify-center py-6 border-b border-border">
                            <Loading className="text-primary" size="small" />
                        </View>
                    );

                case "trendsError":
                    return (
                        <View className="w-full px-3 py-4 gap-2 border-b border-border">
                            <Text className="text-sm text-muted-foreground">{t("error.fetch_trends")}</Text>
                            <TouchableOpacity
                                onPress={() => void fetchTrends()}
                                className="self-start rounded-full bg-secondary px-4 py-2"
                                accessibilityRole="button"
                            >
                                <Text className="text-sm font-semibold text-primary">{t("search.retry", "Retry")}</Text>
                            </TouchableOpacity>
                        </View>
                    );

                case "operators":
                    return (
                        <View className="w-full px-3 py-4 gap-2">
                            <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {t("search.operatorHints", "Search operators")}
                            </Text>
                            <View className="flex-row flex-wrap gap-2">
                                {SEARCH_OPERATORS.map((operator) => {
                                    const [prefix] = operator.operator.split(":");
                                    return (
                                        <TouchableOpacity
                                            key={operator.operator}
                                            onPress={() => handleOperatorPress(operator.operator)}
                                            className="rounded-full bg-secondary px-3 py-1.5"
                                            accessibilityRole="button"
                                            accessibilityLabel={t(`search.operator.${prefix}`, operator.description)}
                                        >
                                            <Text className="text-xs font-medium text-muted-foreground">
                                                {operator.operator}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        </View>
                    );

                case "user":
                    return (
                        <ProfileCard
                            profile={item.profile}
                            showFollowButton
                            onPress={() => handleOpenProfile(item.profile)}
                        />
                    );

                // The same row as any other person — it only swaps in a follow
                // control that can reach an account Oxy has not minted yet.
                case "externalUser":
                    return (
                        <ProfileCard
                            profile={item.profile}
                            accessory={<ExternalActorFollowButton actor={item.actor} />}
                            onPress={() => handleOpenProfile(item.profile)}
                        />
                    );

                case "post":
                    return <PostItem post={item.post} onOpen={commitCurrentQuery} />;

                case "feed": {
                    const feed = toFeedCardData(item.feed);
                    if (!feed) return null;
                    return <FeedCard feed={feed} variant="row" onPress={() => handleOpenFeed(feed.id)} />;
                }

                case "hashtag":
                    return (
                        <TouchableOpacity
                            className="w-full flex-row items-center justify-between px-3 py-3 border-b border-border"
                            onPress={() => handleOpenHashtag(item.hashtag.tag)}
                            accessibilityRole="button"
                        >
                            <View className="flex-1 flex-row items-center gap-3">
                                <View className="w-10 h-10 items-center justify-center rounded-full bg-primary/10">
                                    <Text className="text-xl font-bold text-primary">#</Text>
                                </View>
                                <View className="flex-1">
                                    <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                                        #{item.hashtag.tag}
                                    </Text>
                                    <Text className="mt-0.5 text-sm text-muted-foreground">
                                        {formatCompactNumber(item.hashtag.count)} {t("search.posts", "posts")}
                                    </Text>
                                </View>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                    );

                case "list": {
                    const list = toListCardData(item.list);
                    if (!list) return null;
                    return <ListCard list={list} variant="row" onPress={() => handleOpenList(list.id)} />;
                }

                default:
                    return null;
            }
        },
        [
            theme,
            t,
            handleRecentPress,
            handleRemoveRecent,
            navigateToTrend,
            fetchTrends,
            handleOperatorPress,
            handleOpenProfile,
            handleOpenFeed,
            handleOpenHashtag,
            handleOpenList,
            commitCurrentQuery,
        ],
    );

    const keyExtractor = useCallback((item: SearchRow) => item.key, []);
    const getItemType = useCallback((item: SearchRow) => item.kind, []);

    // Idle with nothing to show yet (no history, no trends) — introduce the screen
    // instead of leaving the operator chips alone on an empty canvas.
    const showIdleIntro = isIdle && searchHistory.length === 0 && visibleTrends.length === 0 && trendsFetched;

    const renderListHeader = () =>
        showIdleIntro ? (
            <EmptyState
                title={t("search.startSearching", "Search Mention")}
                subtitle={t("search.startDescription", "Find people, posts, hashtags, and more")}
                customIcon={<Search size={48} className="text-muted-foreground" />}
            />
        ) : null;

    const renderListEmpty = () => {
        if (isIdle) return null;

        if (searchFailed) {
            return (
                <Error
                    title={t("search.error.title", "Search failed")}
                    message={t(
                        "search.error.message",
                        "We couldn't complete that search. Check your connection and try again.",
                    )}
                    onRetry={retrySearch}
                    hideBackButton
                />
            );
        }

        if (loading) {
            // The people tab paints the row it is about to show; the other tabs mix
            // result kinds (or show posts), so they keep the neutral spinner.
            if (activeTab === "users") {
                return <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />;
            }
            return (
                <View className="items-center justify-center py-20">
                    <Loading className="text-primary" size="large" />
                </View>
            );
        }

        // A resolved cross-network actor is a normal row now, so it keeps the list
        // non-empty on its own — nothing to special-case here.
        return (
            <EmptyState
                title={t("search.noResults", "No results found")}
                subtitle={t("search.tryDifferent", "Try searching for something else")}
                customIcon={<Search size={48} className="text-muted-foreground" />}
            />
        );
    };

    return (
        <>
            <SEO title={t("seo.search.title")} description={t("seo.search.description")} />
            <ThemedView className="flex-1">
                <SafeAreaView className="flex-1" edges={["top"]}>
                    <Header
                        options={{
                            title: t("search.title", "Search"),
                            leftComponents: [
                                <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                    />

                    <View className="mx-4 my-2 flex-row items-center rounded-3xl bg-secondary px-4 py-2">
                        <View className="mr-2">
                            <Search
                                size={18}
                                color={query.trim() ? theme.colors.primary : theme.colors.textSecondary}
                            />
                        </View>
                        <TextInput
                            ref={searchInputRef}
                            className="flex-1 py-2 text-base text-foreground"
                            placeholder={t("search.placeholder", "Search...")}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={query}
                            onChangeText={handleQueryChange}
                            onSubmitEditing={handleSubmit}
                            autoFocus
                            returnKeyType="search"
                        />
                        {query.length > 0 ? (
                            <TouchableOpacity
                                onPress={clearSearch}
                                className="p-1"
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t("search.clearInput", "Clear search")}
                            >
                                <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                            </TouchableOpacity>
                        ) : null}
                    </View>

                    <AnimatedTabBar
                        tabs={tabs}
                        activeTabId={activeTab}
                        onTabPress={handleTabPress}
                        scrollEnabled={true}
                    />

                    {/* ONE scroll container for every state — idle content, results,
                        loading, error and empty all render through this list, so the
                        container never swaps (no scroll or keyboard reset on the
                        first keystroke). */}
                    <View className="flex-1 min-h-0">
                        <FlashList
                            data={rows}
                            keyExtractor={keyExtractor}
                            getItemType={getItemType}
                            renderItem={renderRow}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                            showsVerticalScrollIndicator={false}
                            ListHeaderComponent={renderListHeader()}
                            ListEmptyComponent={renderListEmpty()}
                        />
                    </View>
                </SafeAreaView>
            </ThemedView>
        </>
    );
}
