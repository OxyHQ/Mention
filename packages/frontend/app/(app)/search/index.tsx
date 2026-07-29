import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    type NativeSyntheticEvent,
    type TextInputSelectionChangeEventData,
} from "react-native";
import { SafeAreaView } from "@/lib/SafeAreaViewInterop";
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from "react-i18next";
import { router, useLocalSearchParams } from "expo-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@oxyhq/services/ui/client";
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
    type SearchStarterPackResult,
    type SearchUserResult,
} from "@/services/searchService";
import {
    applyOperatorCompletion,
    buildOperatorValueSuggestions,
    filterRecentSearches,
    findActiveOperatorToken,
    toProfileHandleSuggestion,
    type ActiveOperatorToken,
} from "@/utils/searchSuggestions";
import { Loading } from "@oxyhq/bloom/loading";
import { FlashList } from "@shopify/flash-list";
import AnimatedTabBar from "@/components/common/AnimatedTabBar";
import PostItem from "@/components/Feed/PostItem";
import { Search } from "@oxyhq/bloom/search";
import { Search as SearchIcon } from "@/assets/icons/search-icon";
import { SEO } from "@/components/SEO";
import { ProfileCard, ProfileCardSkeletonList, type ProfileCardData } from "@/components/ProfileCard";
import { FeedCard, type FeedCardData } from "@/components/FeedCard";
import { ListCard, type ListCardData } from "@/components/ListCard";
import { StarterPackCard, type StarterPackCardData } from "@/components/StarterPackCard";
import { ExternalActorFollowButton } from "@/components/search/ExternalActorFollowButton";
import { useExternalActorResolve } from "@/hooks/useExternalActorResolve";
import type { ExternalActorResolution } from "@/services/feedService";
import { EmptyState } from "@/components/common/EmptyState";
import { Error } from "@/components/Error";
import { TrendItemRow } from "@/components/trending/TrendItemRow";
import { useTrendsStore } from "@/stores/trendsStore";
import { useTrendNavigation } from "@/hooks/useTrendNavigation";
import type { Trend } from "@/interfaces/Trend";
import { formatCompactNumber } from "@/utils/formatNumber";
import { logger } from "@/lib/logger";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";

type ResultTab = "posts" | "users" | "feeds" | "hashtags" | "lists" | "starterPacks" | "saved";
type SearchTab = "all" | ResultTab;

type LocalSearchResults = {
    posts: SearchPostResult[];
    users: SearchUserResult[];
    feeds: SearchFeedResult[];
    hashtags: SearchHashtagResult[];
    lists: SearchListResult[];
    starterPacks: SearchStarterPackResult[];
    saved: SearchPostResult[];
};

const EMPTY_RESULTS: LocalSearchResults = {
    posts: [],
    users: [],
    feeds: [],
    hashtags: [],
    lists: [],
    starterPacks: [],
    saved: [],
};

const RESULT_TABS: ResultTab[] = ["posts", "users", "feeds", "hashtags", "lists", "starterPacks", "saved"];
const SEARCH_TABS: SearchTab[] = ["all", ...RESULT_TABS];

function isSearchTab(value: string): value is SearchTab {
    return (SEARCH_TABS as string[]).includes(value);
}

/** Debounce before a keystroke turns into a request. */
const SEARCH_DEBOUNCE_MS = 500;

/** How long a fetched result set stays fresh before React Query would refetch it. */
const SEARCH_STALE_TIME = 5 * 60 * 1000;
/** How long an unused result set is retained in the React Query cache. */
const SEARCH_GC_TIME = 30 * 60 * 1000;

/** Placeholder rows painted while the people tab searches. */
const SKELETON_ROW_COUNT = 8;

/** Trending rows offered on the idle (no query) screen. */
const MAX_IDLE_TRENDS = 5;

/**
 * Recent searches still offered once the viewer starts typing. Kept short: while
 * typing they are a shortcut alongside live results, not the main event.
 */
const MAX_TYPING_RECENTS = 3;

/** Value chips offered when completing an operator token. */
const MAX_OPERATOR_VALUE_SUGGESTIONS = 6;

/**
 * One flattened, virtualized row model so the WHOLE screen — suggestions and
 * results alike — renders through a single FlashList. The scroll container never
 * swaps between states (no scroll/keyboard reset on the first keystroke), and
 * off-screen rows (notably the heavy <PostItem> cards) stay unmounted. `kind`
 * doubles as the FlashList recycle bucket, so a post card is never recycled into
 * a profile row.
 *
 * The suggestion rows are ordinary list CONTENT, which is the whole design: with
 * no floating surface there is no dismissal policy, so they cannot close on blur
 * (see the note on `suggestionRows`). `status` likewise renders loading / error /
 * no-results as a row rather than through `ListEmptyComponent`, which would never
 * fire now that suggestions keep the list non-empty.
 */
type SearchRow =
    | { kind: "sectionHeader"; key: string; title: string; action?: { label: string; onPress: () => void } }
    | { kind: "recent"; key: string; term: string }
    | { kind: "trend"; key: string; trend: Trend }
    | { kind: "trendsLoading"; key: string }
    | { kind: "trendsError"; key: string }
    | { kind: "operators"; key: string }
    | { kind: "operatorValues"; key: string; token: ActiveOperatorToken; values: string[] }
    | { kind: "searchFor"; key: string; term: string }
    | { kind: "goToProfile"; key: string; handle: string }
    | { kind: "status"; key: string; state: "loading" | "error" | "empty" }
    | { kind: "user"; key: string; profile: ProfileCardData }
    | { kind: "externalUser"; key: string; profile: ProfileCardData; actor: ExternalActorResolution }
    | { kind: "post"; key: string; post: SearchPostResult }
    | { kind: "feed"; key: string; feed: SearchFeedResult }
    | { kind: "hashtag"; key: string; hashtag: SearchHashtagResult }
    | { kind: "list"; key: string; list: SearchListResult }
    | { kind: "starterPack"; key: string; pack: SearchStarterPackResult };

/**
 * A page cursor for the active tab's infinite query. Its meaning depends on the
 * tab — an opaque post cursor (string), a user offset or saved-posts page number
 * (number), or `null` for the first page — but the query key pins the tab, so
 * only one interpretation is ever live at a time.
 */
type SearchPageParam = string | number | null;

/**
 * One page of results for the active tab, plus the param to request the NEXT page
 * (`undefined` ⇒ this tab is exhausted). The "all" tab yields a single terminal
 * page (a one-shot fan-out overview); every single-category tab paginates until
 * its source runs out — posts by an opaque cursor, users/feeds/hashtags/lists by
 * an offset, saved by a page number.
 */
interface SearchResultsPage {
    results: LocalSearchResults;
    nextPageParam: SearchPageParam | undefined;
}

/**
 * Fetch one page for a tab — the `queryFn` behind the infinite search query.
 *
 * The "all" tab fans out over every source via `searchAll`, whose `allSettled`
 * keeps the "one flaky source degrades that section, a total failure errors"
 * semantics; a single-category tab fetches only its own source. Every underlying
 * request carries the SDK's per-request timeout (5s on the linked client, 15s on
 * the public client), so a hanging source REJECTS rather than stalling the
 * screen — which is what lets React Query settle loading deterministically.
 */
async function fetchSearchPage(
    tab: SearchTab,
    query: string,
    pageParam: SearchPageParam,
    canUsePrivateApi: boolean,
    signal?: AbortSignal,
): Promise<SearchResultsPage> {
    switch (tab) {
        case "all": {
            const all = await searchService.searchAll(
                query,
                canUsePrivateApi,
                signal,
            );
            return {
                results: {
                    posts: all.posts ?? [],
                    users: all.users ?? [],
                    feeds: all.feeds ?? [],
                    hashtags: all.hashtags ?? [],
                    lists: all.lists ?? [],
                    starterPacks: all.starterPacks ?? [],
                    saved: all.saved ?? [],
                },
                nextPageParam: undefined,
            };
        }
        case "posts": {
            // Auth-gated: `/search` 401s until the private API is ready. Don't fire
            // early — the query is keyed on `canUsePrivateApi`, so it refetches (and
            // this page fills in) the moment the session lands.
            if (!canUsePrivateApi) return { results: EMPTY_RESULTS, nextPageParam: undefined };
            const cursor = typeof pageParam === "string" ? pageParam : undefined;
            const { posts, hasMore, nextCursor } = await searchService.searchPostsPage(query, cursor, signal);
            return { results: { ...EMPTY_RESULTS, posts }, nextPageParam: hasMore ? nextCursor : undefined };
        }
        case "users": {
            const offset = typeof pageParam === "number" ? pageParam : 0;
            const { users, hasMore, nextOffset } = await searchService.searchUsersPage(query, offset);
            return { results: { ...EMPTY_RESULTS, users }, nextPageParam: hasMore ? nextOffset : undefined };
        }
        case "saved": {
            // Auth-gated (`/posts/saved`) — see the posts tab above.
            if (!canUsePrivateApi) return { results: EMPTY_RESULTS, nextPageParam: undefined };
            const page = typeof pageParam === "number" ? pageParam : 1;
            const { posts, hasMore, nextPage } = await searchService.searchSavedPage(query, page, signal);
            return { results: { ...EMPTY_RESULTS, saved: posts }, nextPageParam: hasMore ? nextPage : undefined };
        }
        case "feeds": {
            const offset = typeof pageParam === "number" ? pageParam : 0;
            const { feeds, hasMore, nextOffset } = await searchService.searchFeedsPage(query, offset, signal);
            return { results: { ...EMPTY_RESULTS, feeds }, nextPageParam: hasMore ? nextOffset : undefined };
        }
        case "hashtags": {
            const offset = typeof pageParam === "number" ? pageParam : 0;
            const { hashtags, hasMore, nextOffset } = await searchService.searchHashtagsPage(query, offset, signal);
            return { results: { ...EMPTY_RESULTS, hashtags }, nextPageParam: hasMore ? nextOffset : undefined };
        }
        case "lists": {
            // Auth-gated (`/lists`) — see the posts tab above.
            if (!canUsePrivateApi) return { results: EMPTY_RESULTS, nextPageParam: undefined };
            const offset = typeof pageParam === "number" ? pageParam : 0;
            const { lists, hasMore, nextOffset } = await searchService.searchListsPage(query, offset, signal);
            return { results: { ...EMPTY_RESULTS, lists }, nextPageParam: hasMore ? nextOffset : undefined };
        }
        case "starterPacks": {
            // Public (`/starter-packs` reads the viewer optionally), so it runs for
            // signed-out viewers too — no `canUsePrivateApi` gate.
            const page = typeof pageParam === "number" ? pageParam : 1;
            const { starterPacks, hasMore, nextPage } = await searchService.searchStarterPacksPage(query, page, signal);
            return { results: { ...EMPTY_RESULTS, starterPacks }, nextPageParam: hasMore ? nextPage : undefined };
        }
    }
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

function toStarterPackCardData(pack: SearchStarterPackResult): StarterPackCardData | null {
    const id = String(pack._id || pack.id || "");
    if (!id) return null;
    const memberCount = pack.memberCount ?? (pack.memberOxyUserIds || []).length;
    return {
        id,
        name: pack.name || "Untitled Pack",
        description: pack.description,
        creator: pack.creator,
        memberCount,
        useCount: pack.useCount || 0,
        memberAvatars: pack.memberAvatars ?? [],
        totalMembers: memberCount,
    };
}

export default function SearchIndex() {
    const { t } = useTranslation();
    const theme = useTheme();
    const safeBack = useSafeBack();
    const queryClient = useQueryClient();
    const params = useLocalSearchParams();
    const urlQuery = (params.q as string) || "";

    // The auth-gated search sources (posts, lists, saved) 401 until the PRIVATE
    // API is ready — which lags `isAuthenticated` by 5–25s during the SSO
    // cold-boot. `canUsePrivateApi` both GATES those fetchers (so they never fire
    // early → no 401 noise) and is KEYED into the search query below, so the query
    // refetches and those sections fill in the moment the session lands. A genuine
    // signed-out viewer keeps them quietly empty and still gets people + feeds.
    const { canUsePrivateApi, user } = useAuth();
    const viewerId = user?.id;

    const [query, setQuery] = useState(urlQuery);
    // `query` drives the input box; `debouncedQuery` drives the actual request
    // (and the React Query key). A keystroke schedules the debounce below; an
    // explicit submit / tab press / recent tap commits it instantly.
    const [debouncedQuery, setDebouncedQuery] = useState(urlQuery);
    const [activeTab, setActiveTab] = useState<SearchTab>("all");
    // Caret offset, so an operator completion targets the token the viewer is
    // actually editing rather than always the last one. Every write below keeps it
    // at the end of the text it just set; `onSelectionChange` then reports the
    // real position. A stale value is harmless — `findActiveOperatorToken` clamps
    // it into the current query, which degrades to "the last token".
    const [caret, setCaret] = useState(urlQuery.length);

    // Pending debounce timer, set and cleared INSIDE event handlers — never an
    // Effect — so a burst of keystrokes collapses to exactly one search.
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchInputRef = useRef<TextInput>(null);

    // A `/search?q=…` deep link can change while this screen stays mounted.
    // Adjusting state during render (instead of an Effect) keeps the input AND the
    // search in lockstep with the URL without an extra render pass.
    const [syncedUrlQuery, setSyncedUrlQuery] = useState(urlQuery);
    if (urlQuery !== syncedUrlQuery) {
        setSyncedUrlQuery(urlQuery);
        setQuery(urlQuery);
        setDebouncedQuery(urlQuery);
        setCaret(urlQuery.length);
    }

    // --- Search history (Storage-backed, cached by React Query) ---
    const searchHistoryQueryKey = useMemo(
        () => viewerQueryKeys.searchHistory(viewerId),
        [viewerId],
    );
    const { data: searchHistory = [] } = useQuery({
        queryKey: searchHistoryQueryKey,
        queryFn: () => searchService.getSearchHistory(viewerId),
        staleTime: Infinity,
    });

    const setSearchHistory = useCallback(
        (history: string[]) => {
            queryClient.setQueryData<string[]>(searchHistoryQueryKey, history);
        },
        [queryClient, searchHistoryQueryKey],
    );

    // History records what the user MEANT to search — an explicit submit or an
    // opened result — never the partial words a debounced keystroke produced.
    const commitToHistory = useCallback(
        (term: string) => {
            const trimmed = term.trim();
            if (!trimmed) return;
            searchService
                .addToSearchHistory(trimmed, viewerId)
                .then(setSearchHistory)
                .catch((error: unknown) => logger.warn("Failed to save search history", { error }));
        },
        [setSearchHistory, viewerId],
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
        const subscriptionId = startTrendsPolling();
        return () => stopTrendsPolling(subscriptionId);
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

    const trimmedDebounced = debouncedQuery.trim();

    // The ONE data owner for search results. React Query owns dedup, staleness,
    // caching, cancellation and the whole in-flight lifecycle — the hand-rolled
    // loading / requestId / inFlight / stale-guard machine (and the bug where the
    // `finally` only cleared loading when NOT stale, so an interleave could pin it
    // true forever) is gone.
    const {
        data: searchData,
        isPending,
        isFetching,
        isFetchingNextPage,
        hasNextPage,
        fetchNextPage,
        isError: searchFailed,
        refetch: refetchSearch,
    } = useInfiniteQuery({
        queryKey: viewerQueryKeys.search(
            viewerId,
            activeTab,
            trimmedDebounced,
            canUsePrivateApi,
        ),
        queryFn: ({ pageParam, signal }) => fetchSearchPage(
            activeTab,
            trimmedDebounced,
            pageParam,
            canUsePrivateApi,
            signal,
        ),
        initialPageParam: null as SearchPageParam,
        // Each tab reports its own "next page" token; `undefined` stops paging, so
        // the "all" overview settles after one page while every single-category tab
        // pages until its source runs out.
        getNextPageParam: (lastPage) => lastPage.nextPageParam,
        enabled: trimmedDebounced.length > 0,
        staleTime: SEARCH_STALE_TIME,
        gcTime: SEARCH_GC_TIME,
        // Fail fast to the error state (with a manual Retry) rather than stacking
        // React Query retries on top of the transport's own bounded retry+timeout.
        retry: false,
    });

    // Flatten every loaded page into ONE result set per category. Only the active
    // tab's category actually grows across pages; the rest stay empty. The append
    // is order-preserving, so the backend's native-first ordering renders exactly
    // as returned — never re-sorted client-side — and appended pages never
    // duplicate a prior page's rows (the cursor/offset sort is stable).
    const results = useMemo<LocalSearchResults>(() => {
        const pages = searchData?.pages;
        if (!pages || pages.length === 0) return EMPTY_RESULTS;
        return pages.reduce<LocalSearchResults>(
            (acc, page) => ({
                posts: acc.posts.concat(page.results.posts),
                users: acc.users.concat(page.results.users),
                feeds: acc.feeds.concat(page.results.feeds),
                hashtags: acc.hashtags.concat(page.results.hashtags),
                lists: acc.lists.concat(page.results.lists),
                starterPacks: acc.starterPacks.concat(page.results.starterPacks),
                saved: acc.saved.concat(page.results.saved),
            }),
            EMPTY_RESULTS,
        );
    }, [searchData]);

    // The full-screen loading state spans BOTH the debounce wait and the FIRST
    // page fetch: while the box holds a query the results don't yet reflect, the
    // query sits disabled with no data (`isPending`); the first fetch keeps
    // `isPending`; a retry/refetch shows as `isFetching`. A next-page fetch is
    // deliberately excluded — it keeps the existing rows on screen and shows the
    // footer spinner instead. Every source request times out, so all settle
    // deterministically — loading can never stick the way the old stale-guard could.
    const loading = isPending || (isFetching && !isFetchingNextPage);

    const clearDebounce = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
    }, []);

    // Commit a query to the search NOW: cancel any pending debounce and feed the
    // value straight into the query key. Used by submit / tab press / recent tap.
    const commitQuery = useCallback(
        (term: string) => {
            clearDebounce();
            setDebouncedQuery(term.trim());
        },
        [clearDebounce],
    );

    const handleQueryChange = useCallback(
        (text: string) => {
            setQuery(text);
            setCaret(text.length);
            clearDebounce();
            const trimmed = text.trim();
            // Clearing the box returns the screen to its idle state at once (the
            // query goes disabled); any other keystroke schedules the debounce that
            // will feed the query key. The timer is set/cleared here, in the event
            // handler — the correct place for a debounce, never an Effect.
            if (!trimmed) {
                setDebouncedQuery("");
                return;
            }
            debounceTimerRef.current = setTimeout(() => {
                debounceTimerRef.current = null;
                setDebouncedQuery(trimmed);
            }, SEARCH_DEBOUNCE_MS);
        },
        [clearDebounce],
    );

    const clearSearch = useCallback(() => {
        setQuery("");
        setCaret(0);
        commitQuery("");
        searchInputRef.current?.focus();
    }, [commitQuery]);

    // The box reports where the caret really is. Read-only: the selection is never
    // driven from state, so this only ever refines what the write handlers assumed.
    const handleSelectionChange = useCallback(
        (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
            setCaret(event.nativeEvent.selection.end);
        },
        [],
    );

    const handleSubmit = useCallback(() => {
        const searchQuery = query.trim();
        if (!searchQuery) return;
        commitToHistory(searchQuery);
        commitQuery(searchQuery);
    }, [query, commitToHistory, commitQuery]);

    const retrySearch = useCallback(() => {
        void refetchSearch();
    }, [refetchSearch]);

    // Switching tabs searches straight away instead of waiting out the debounce —
    // a tab whose results are already cached (every tab is, right after an "all"
    // search) swaps in with no request at all. Committing the current query also
    // flushes a still-pending debounce so a mid-typing tab press isn't delayed.
    const handleTabPress = useCallback(
        (id: string) => {
            if (!isSearchTab(id)) return;
            setActiveTab(id);
            if (query.trim()) commitQuery(query);
        },
        [query, commitQuery],
    );

    // --- Idle-state handlers ---
    const handleRecentPress = useCallback(
        (term: string) => {
            setQuery(term);
            setCaret(term.length);
            commitToHistory(term);
            commitQuery(term);
        },
        [commitToHistory, commitQuery],
    );

    const handleRemoveRecent = useCallback(
        async (term: string) => {
            setSearchHistory(await searchService.removeFromSearchHistory(term, viewerId));
        },
        [setSearchHistory, viewerId],
    );

    const handleClearHistory = useCallback(async () => {
        await searchService.clearSearchHistory(viewerId);
        setSearchHistory([]);
    }, [setSearchHistory, viewerId]);

    // Seed the box from an operator chip. A parameterised operator contributes its
    // prefix and waits for a value; a complete one (`from:me`, `has:media`) goes in
    // whole and searches straight away. Routed through the same debounce path a
    // keystroke takes.
    const handleOperatorPress = useCallback(
        (insert: string) => {
            handleQueryChange(insert);
            searchInputRef.current?.focus();
        },
        [handleQueryChange],
    );

    // Complete the operator token the caret sits in, preserving the rest of the
    // query on either side of it.
    const handleOperatorValuePress = useCallback(
        (token: ActiveOperatorToken, value: string) => {
            handleQueryChange(applyOperatorCompletion(query, token, value));
            searchInputRef.current?.focus();
        },
        [handleQueryChange, query],
    );

    const handleGoToProfile = useCallback(
        (handle: string) => {
            commitCurrentQuery();
            router.push(`/@${handle}`);
        },
        [commitCurrentQuery],
    );

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

    const handleOpenStarterPack = useCallback(
        (packId: string) => {
            commitCurrentQuery();
            router.push(`/starter-packs/${packId}`);
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
            { id: "starterPacks", label: t("search.tabs.starterPacks", "Starter Packs") },
            { id: "saved", label: t("search.tabs.saved", "Saved") },
        ],
        [t],
    );

    const trimmedQuery = query.trim();
    const isIdle = trimmedQuery.length === 0;

    /**
     * Suggestion rows, rendered as a header SECTION above the results — and, in
     * the typing state, rendered *at the same time as* them.
     *
     * This is the deliberate shape of the feature. Mention has no floating
     * autocomplete and is not getting one: the suggestions are list content, so
     * "does not close when the input loses focus" holds STRUCTURALLY rather than
     * by policy — there is no overlay to dismiss, and correspondingly no
     * `onBlur` handler anywhere in this file. Please do not "finish" this by
     * adding one. Bluesky shipped exactly that handler in `6b342f61b`
     * (2026-06-25) and deleted it 25 days later in `92ef1528b` (2026-07-20),
     * noting that on web their overlay's own focus management made the results
     * uninteractable. The overlay is what creates the problem; not having one is
     * the fix.
     *
     * Idle (empty box): recents, then trending, then the operator cheat-sheet.
     * Typing: commit-this-query, an optional go-to-profile, an optional operator
     * completion, then recents FILTERED by what has been typed — the history
     * stays reachable instead of vanishing on the first keystroke.
     */
    const suggestionRows = useMemo<SearchRow[]>(() => {
        const rows: SearchRow[] = [];

        if (isIdle) {
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
        }

        rows.push({ kind: "searchFor", key: "suggestion-search-for", term: trimmedQuery });

        const handle = toProfileHandleSuggestion(trimmedQuery);
        if (handle) {
            rows.push({ kind: "goToProfile", key: `suggestion-profile-${handle}`, handle });
        }

        // A targeted completion for the operator being typed replaces the full
        // cheat-sheet here — once the viewer has committed to `from:`, the other
        // nine operators are noise.
        const token = findActiveOperatorToken(query, caret);
        if (token) {
            const values = buildOperatorValueSuggestions(token, searchHistory, MAX_OPERATOR_VALUE_SUGGESTIONS);
            if (values.length > 0) {
                rows.push({ kind: "operatorValues", key: `suggestion-operator-${token.prefix}`, token, values });
            }
        }

        const recents = filterRecentSearches(searchHistory, trimmedQuery, MAX_TYPING_RECENTS);
        if (recents.length > 0) {
            // No "Clear all" while filtering: the action clears the WHOLE history,
            // not the subset on screen, so offering it here would misdescribe it.
            rows.push({
                kind: "sectionHeader",
                key: "header-recent",
                title: t("search.recentSearches", "Recent searches"),
            });
            for (const term of recents) {
                rows.push({ kind: "recent", key: `recent-${term}`, term });
            }
        }

        return rows;
    }, [
        isIdle,
        query,
        trimmedQuery,
        caret,
        searchHistory,
        visibleTrends,
        trendsFetched,
        trendsLoading,
        trendsError,
        t,
        handleClearHistory,
    ]);

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
            isAll || activeTab === "starterPacks",
            t("search.sections.starterPacks", "Starter Packs"),
            results.starterPacks.map((pack): SearchRow => ({
                kind: "starterPack",
                key: `starter-pack-${pack._id || pack.id}`,
                pack,
            })),
        );
        pushSection(
            isAll || activeTab === "saved",
            t("search.sections.saved", "Saved"),
            results.saved.map((post): SearchRow => ({ kind: "post", key: `saved-${post.id}`, post })),
        );

        return rows;
    }, [isIdle, loading, searchFailed, activeTab, results, externalActor, t]);

    /**
     * Loading / error / no-results, as a ROW rather than `ListEmptyComponent`.
     * The suggestion rows above keep the list non-empty at all times now, so
     * `ListEmptyComponent` would never render again — the state has to live in
     * the data. Idle has no status: nothing has been asked yet.
     */
    const statusRow = useMemo<SearchRow | null>(() => {
        if (isIdle) return null;
        if (loading) return { kind: "status", key: "status-loading", state: "loading" };
        if (searchFailed) return { kind: "status", key: "status-error", state: "error" };
        if (resultRows.length === 0) return { kind: "status", key: "status-empty", state: "empty" };
        return null;
    }, [isIdle, loading, searchFailed, resultRows.length]);

    const rows = useMemo<SearchRow[]>(
        () => (statusRow ? [...suggestionRows, ...resultRows, statusRow] : [...suggestionRows, ...resultRows]),
        [suggestionRows, resultRows, statusRow],
    );

    // Reaching the end of a results tab pulls its next page. The idle list and the
    // "all" overview report no next page, so this is a no-op there; the guard
    // collapses overlapping end-reached events into one in-flight fetch.
    const handleEndReached = useCallback(() => {
        if (isIdle) return;
        if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, [isIdle, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
                            <TrendItemRow
                                trend={item.trend}
                                onPress={(trend) => navigateToTrend(trend, "search")}
                                size="large"
                            />
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
                                {SEARCH_OPERATORS.map((operator) => (
                                    <TouchableOpacity
                                        key={operator.operator}
                                        onPress={() => handleOperatorPress(operator.insert)}
                                        className="rounded-full bg-secondary px-3 py-1.5"
                                        accessibilityRole="button"
                                        accessibilityLabel={t(`search.operator.${operator.labelKey}`, operator.description)}
                                    >
                                        <Text className="text-xs font-medium text-muted-foreground">
                                            {operator.operator}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>
                    );

                case "operatorValues":
                    return (
                        <View className="w-full px-3 py-4 gap-2 border-b border-border">
                            <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {t("search.suggestions.completeOperator", "Complete {{prefix}}:", { prefix: item.token.prefix })}
                            </Text>
                            <View className="flex-row flex-wrap gap-2">
                                {item.values.map((value) => (
                                    <TouchableOpacity
                                        key={value}
                                        onPress={() => handleOperatorValuePress(item.token, value)}
                                        className="rounded-full bg-secondary px-3 py-1.5"
                                        accessibilityRole="button"
                                    >
                                        <Text className="text-xs font-medium text-muted-foreground">
                                            {`${item.token.prefix}:${value}`}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>
                    );

                case "searchFor":
                    return (
                        <TouchableOpacity
                            className="w-full flex-row items-center gap-3 px-3 py-3 border-b border-border"
                            onPress={handleSubmit}
                            accessibilityRole="button"
                        >
                            <SearchIcon size={18} className="text-muted-foreground" />
                            <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                                {t('search.suggestions.searchFor', 'Search for "{{query}}"', { query: item.term })}
                            </Text>
                        </TouchableOpacity>
                    );

                case "goToProfile":
                    return (
                        <TouchableOpacity
                            className="w-full flex-row items-center gap-3 px-3 py-3 border-b border-border"
                            onPress={() => handleGoToProfile(item.handle)}
                            accessibilityRole="button"
                        >
                            <Ionicons name="person-outline" size={18} color={theme.colors.textSecondary} />
                            <Text className="flex-1 text-base text-foreground" numberOfLines={1}>
                                {t("search.suggestions.goToProfile", "Go to @{{handle}}", { handle: item.handle })}
                            </Text>
                        </TouchableOpacity>
                    );

                // Loading is checked before the error state so a retry/refetch shows
                // the spinner rather than lingering on the error card.
                case "status":
                    if (item.state === "loading") {
                        // The people tab paints the row it is about to show; the other
                        // tabs mix result kinds (or show posts), so they keep the
                        // neutral spinner.
                        if (activeTab === "users") {
                            return <ProfileCardSkeletonList count={SKELETON_ROW_COUNT} showFollowButton />;
                        }
                        return (
                            <View className="items-center justify-center py-20">
                                <Loading className="text-primary" size="large" />
                            </View>
                        );
                    }
                    if (item.state === "error") {
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
                    // A resolved cross-network actor is a normal row, so it keeps the
                    // results non-empty on its own — nothing to special-case here.
                    return (
                        <EmptyState
                            title={t("search.noResults", "No results found")}
                            subtitle={t("search.tryDifferent", "Try searching for something else")}
                            customIcon={<SearchIcon size={48} className="text-muted-foreground" />}
                        />
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

                case "starterPack": {
                    const pack = toStarterPackCardData(item.pack);
                    if (!pack) return null;
                    return (
                        <View className="w-full px-3 py-2">
                            <StarterPackCard pack={pack} onPress={() => handleOpenStarterPack(pack.id)} />
                        </View>
                    );
                }

                default:
                    return null;
            }
        },
        [
            theme,
            t,
            activeTab,
            handleRecentPress,
            handleRemoveRecent,
            navigateToTrend,
            fetchTrends,
            handleOperatorPress,
            handleOperatorValuePress,
            handleSubmit,
            handleGoToProfile,
            retrySearch,
            handleOpenProfile,
            handleOpenFeed,
            handleOpenHashtag,
            handleOpenList,
            handleOpenStarterPack,
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
                customIcon={<SearchIcon size={48} className="text-muted-foreground" />}
            />
        ) : null;

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

                    <View className="mx-4 my-2">
                        <Search
                            ref={searchInputRef}
                            label={t("search.placeholder", "Search...")}
                            value={query}
                            onChangeText={handleQueryChange}
                            onSelectionChange={handleSelectionChange}
                            onSubmitEditing={handleSubmit}
                            onClearText={clearSearch}
                            autoFocus
                        />
                    </View>

                    <AnimatedTabBar
                        tabs={tabs}
                        activeTabId={activeTab}
                        onTabPress={handleTabPress}
                        scrollEnabled={true}
                    />

                    {/* ONE scroll container for every state — suggestions, results,
                        loading, error and empty all render through this list as ROWS,
                        so the container never swaps (no scroll or keyboard reset on
                        the first keystroke) and the suggestions have no focus-bound
                        lifecycle to get wrong. */}
                    <View className="flex-1 min-h-0">
                        <FlashList
                            data={rows}
                            keyExtractor={keyExtractor}
                            getItemType={getItemType}
                            renderItem={renderRow}
                            keyboardShouldPersistTaps="handled"
                            keyboardDismissMode="on-drag"
                            showsVerticalScrollIndicator={false}
                            onEndReached={handleEndReached}
                            onEndReachedThreshold={0.5}
                            ListHeaderComponent={renderListHeader()}
                            ListFooterComponent={
                                isFetchingNextPage ? (
                                    <View className="items-center justify-center py-4">
                                        <Loading className="text-primary" size="small" />
                                    </View>
                                ) : null
                            }
                        />
                    </View>
                </SafeAreaView>
            </ThemedView>
        </>
    );
}
