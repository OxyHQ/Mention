import { createLogger } from '@oxy.so/core/logger';
import { authenticatedClient, isUnauthorizedError, publicClient } from "@/utils/api";
import { oxyServices } from "@/lib/oxyServices";
import { feedService } from "./feedService";
import { Storage } from "@/utils/storage";
import { viewerStorageKey, type ViewerId } from "@/lib/viewerQueryKeys";
import type { User } from '@oxy.so/core';
import type { HydratedPost } from '@mention/shared-types';
import type { StarterPackSummary } from './starterPacksService';
import type { SearchOverviewResponse } from '@mention/shared-types';

const logger = createLogger('SearchService');

export type SearchPostResult = HydratedPost;

export type SearchUserResult = User & {
  handle?: string;
  isFederated?: boolean;
  type?: string;
  instance?: string;
  federation?: { domain?: string };
};

export interface SearchOwnerResult {
  username?: string;
  handle?: string;
  displayName?: string;
  name?: { displayName?: string };
  avatar?: string;
}

export interface SearchFeedResult {
  id?: string;
  _id?: string;
  uri?: string;
  title?: string;
  displayName?: string;
  description?: string;
  avatar?: string | null;
  creator?: SearchOwnerResult;
  owner?: SearchOwnerResult;
  likeCount?: number;
  subscriberCount?: number;
  memberCount?: number;
}

export interface SearchHashtagResult {
  tag: string;
  count: number;
}

/**
 * A starter pack as the search tab renders it — the same document the rest of
 * the app already models, so a result row feeds the shared `StarterPackCard`
 * without a second shape to keep in sync.
 */
export type SearchStarterPackResult = StarterPackSummary;

export interface SearchListResult {
  id?: string;
  _id?: string;
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  avatar?: string | null;
  owner?: SearchOwnerResult;
  createdBy?: SearchOwnerResult;
  creator?: SearchOwnerResult;
  purpose?: string;
  itemCount?: number;
  memberCount?: number;
}

export interface SearchResults {
  posts?: SearchPostResult[];
  hashtags?: SearchHashtagResult[];
  feeds?: SearchFeedResult[];
  users?: SearchUserResult[];
  lists?: SearchListResult[];
  saved?: SearchPostResult[];
  starterPacks?: SearchStarterPackResult[];
}

/** Page size for the paginated single-category search tabs. */
export const SEARCH_PAGE_LIMIT = 20;

/**
 * Hashtag rows shown in the compact "All" overview (the multi-section fan-out),
 * kept small so it stays a preview. The dedicated Hashtags tab pages at
 * {@link SEARCH_PAGE_LIMIT} instead.
 */
const SEARCH_OVERVIEW_HASHTAG_LIMIT = 5;

/** The offset-window echo every paginated Mention search endpoint returns. */
interface SearchOffsetPagination {
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** A page of post results plus the opaque cursor to request the next page. */
export interface SearchPostsPage {
  posts: SearchPostResult[];
  hasMore: boolean;
  nextCursor?: string;
}

/** A page of user results plus the offset to request the next page. */
export interface SearchUsersPage {
  users: SearchUserResult[];
  hasMore: boolean;
  nextOffset: number;
}

/** A page of saved-post results plus the page number to request next. */
export interface SearchSavedPage {
  posts: SearchPostResult[];
  hasMore: boolean;
  nextPage: number;
}

/** A page of feed results plus the offset to request the next page. */
export interface SearchFeedsPage {
  feeds: SearchFeedResult[];
  hasMore: boolean;
  nextOffset: number;
}

/** A page of hashtag results plus the offset to request the next page. */
export interface SearchHashtagsPage {
  hashtags: SearchHashtagResult[];
  hasMore: boolean;
  nextOffset: number;
}

/** A page of list results plus the offset to request the next page. */
export interface SearchListsPage {
  lists: SearchListResult[];
  hasMore: boolean;
  nextOffset: number;
}

/** A page of starter-pack results plus the page number to request next. */
export interface SearchStarterPacksPage {
  starterPacks: SearchStarterPackResult[];
  hasMore: boolean;
  nextPage: number;
}

/** The page window `GET /starter-packs` echoes back on every listing. */
interface StarterPackListResponse {
  items?: SearchStarterPackResult[];
  /** `null` when not computed — a SEARCH does not pay for a `count(*)`. */
  total?: number | null;
  page?: number;
  totalPages?: number | null;
  /** The paging signal. Derived from an over-fetched row, not from a total. */
  hasMore?: boolean;
}

const SEARCH_HISTORY_KEY = 'mention_search_history';
const MAX_SEARCH_HISTORY = 10;

export const getSearchHistoryStorageKey = (viewerId: ViewerId): string =>
  viewerStorageKey(SEARCH_HISTORY_KEY, viewerId);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHydratedPost(value: unknown): value is SearchPostResult {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isRecord(value.content) ||
    !isRecord(value.attachments) ||
    !isRecord(value.user) ||
    !Array.isArray(value.authors) ||
    !isRecord(value.engagement) ||
    !isRecord(value.viewerState) ||
    !isRecord(value.permissions) ||
    !isRecord(value.metadata)
  ) {
    return false;
  }

  return !(
    'isLiked' in value ||
    'isDownvoted' in value ||
    'isBoosted' in value ||
    'isSaved' in value ||
    'handle' in value.user ||
    'avatarUrl' in value.user ||
    'isVerified' in value.user
  );
}

/** One operator chip in the search hint cluster. */
export interface SearchOperatorHint {
  /** The chip's label — the operator's full spelling. */
  operator: string;
  /**
   * What tapping the chip puts in the box. A PARAMETERISED operator seeds only
   * its prefix and waits for a value (`from:`); a COMPLETE one is inserted whole
   * (`from:me`). The distinction isn't derivable from the label, so it is stated.
   */
  insert: string;
  /** Suffix of this chip's `search.operator.*` i18n key — unique per chip. */
  labelKey: string;
  description: string;
}

/**
 * Search operator definitions for display in the UI hint.
 *
 * `from:me` / `to:me` are resolved SERVER-side, against the authenticated
 * viewer; the query text carries the literal `me`. Bluesky arrived at the same
 * split in `b0a40145e`, deleting the client-side `from:me` → DID substitution
 * they used to do so the backend owns the resolution — the client has no
 * business rewriting a query it doesn't own the identity for.
 */
export const SEARCH_OPERATORS: readonly SearchOperatorHint[] = [
  { operator: 'from:username', insert: 'from:', labelKey: 'from', description: 'Posts by a specific user' },
  { operator: 'from:me', insert: 'from:me', labelKey: 'fromMe', description: 'Your own posts' },
  { operator: 'to:username', insert: 'to:', labelKey: 'to', description: 'Posts mentioning a specific user' },
  { operator: 'to:me', insert: 'to:me', labelKey: 'toMe', description: 'Posts mentioning you' },
  { operator: 'since:YYYY-MM-DD', insert: 'since:', labelKey: 'since', description: 'Posts after a date' },
  { operator: 'until:YYYY-MM-DD', insert: 'until:', labelKey: 'until', description: 'Posts before a date' },
  { operator: 'has:media', insert: 'has:media', labelKey: 'hasMedia', description: 'Posts with media' },
  { operator: 'has:links', insert: 'has:links', labelKey: 'hasLinks', description: 'Posts with links' },
  { operator: 'min_likes:N', insert: 'min_likes:', labelKey: 'min_likes', description: 'Minimum likes' },
  { operator: 'min_boosts:N', insert: 'min_boosts:', labelKey: 'min_boosts', description: 'Minimum boosts' },
];

/**
 * Posts, lists and saved posts live behind the authenticated API. A signed-out
 * viewer gets a 401 from those sources, which means "this source has nothing for
 * you" — NOT that the search failed. Every other failure propagates so the search
 * screen can render a real error state (with retry) instead of an empty result
 * list that looks like "no matches".
 */
function emptyIfSignedOut<T>(error: unknown, source: string): T[] {
  if (isUnauthorizedError(error)) {
    logger.info("Skipping auth-gated search source for signed-out viewer", { source });
    return [];
  }
  throw error;
}

/**
 * A cancellation, as opposed to a failure.
 *
 * React Query aborts the previous query's signal on every new one, so a
 * cancelled search must NOT fall through to a fallback lookup or an error
 * state — the caller no longer wants the answer. The SDK surfaces both a
 * caller abort and a timeout as an `AbortError` with `status: 0`, so the name
 * is what distinguishes them from a real HTTP failure.
 */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'CanceledError')
  );
}

/**
 * People search, cancellable.
 *
 * `oxyServices.searchProfiles()` accepts no `AbortSignal` (its signature is
 * `(query, pagination)`), which made People the ONE search lane that could not
 * be cancelled: every keystroke started a profile search that ran to
 * completion and had its result thrown away, while holding one of the SDK
 * request queue's ten slots. Since people search is also the slowest lane —
 * Oxy's `/profiles/search` has no trigram index on `users`, so it is a
 * sequential scan — those zombies were the ones starving the live request.
 *
 * So this calls the same endpoint through the public `httpService` seam, which
 * DOES take a signal. It deliberately mirrors the SDK method rather than
 * improving on it: same path, same query params, and the same `cache: true` /
 * 2-minute TTL, because a people search repeated inside two minutes is the
 * common case and that cache is the one piece of the SDK path worth keeping.
 *
 * `retry: false` is belt-and-braces — the client-wide `enableRetry: false` in
 * `utils/api.ts` covers the Mention client, and this one is the Oxy instance.
 * Delete this helper and pass the signal to `searchProfiles` directly once the
 * SDK accepts one (see the note in `utils/api.ts`).
 *
 * The OTHER `searchProfiles` call sites (starter packs, lists, privacy
 * screens) are one-shot and not typed into, so they stay on the SDK method.
 */
async function searchProfilesCancellable(
  query: string,
  pagination: { limit: number; offset?: number },
  signal?: AbortSignal,
): Promise<{ data: SearchUserResult[]; pagination?: { total?: number; limit?: number; offset?: number; hasMore?: boolean } }> {
  const params: Record<string, unknown> = { query, limit: pagination.limit };
  if (pagination.offset !== undefined) params.offset = pagination.offset;

  const response = await oxyServices.httpService.get<{
    data?: SearchUserResult[];
    pagination?: { total?: number; limit?: number; offset?: number; hasMore?: boolean };
  }>('/profiles/search', { params, signal, retry: false, cache: true, cacheTTL: 2 * 60 * 1000 });

  if (!response || !Array.isArray(response.data)) {
    throw new Error('Unexpected search response format');
  }
  return { data: response.data, pagination: response.pagination };
}

/** A source the "All" tab fans out over. See {@link searchAllSources}. */
export type SearchAllSource = 'users' | 'overview' | 'posts' | 'saved';

/**
 * The sources the "All" tab runs for this viewer.
 *
 * The AUTH-GATED ones (posts, saved — both behind the authenticated API) only
 * once the private API is ready: during the SSO cold-boot the viewer can be
 * authenticated while the private API is still pending, and firing then would
 * 401 (console noise, not a result). A signed-out viewer never runs them — a
 * quiet "nothing here", never a 401 storm. `lists` is not among them: the
 * overview serves it publicly.
 */
export function searchAllSources(canUsePrivateApi: boolean): readonly SearchAllSource[] {
  return canUsePrivateApi ? ['users', 'overview', 'posts', 'saved'] : ['users', 'overview'];
}

/** Every section present, each the concatenation of what the parts carried. */
export function mergeSearchResults(parts: readonly SearchResults[]): Required<SearchResults> {
  const merged: Required<SearchResults> = {
    posts: [], users: [], feeds: [], hashtags: [], lists: [], saved: [], starterPacks: [],
  };
  for (const part of parts) {
    for (const key of Object.keys(merged) as (keyof SearchResults)[]) {
      const items = part[key];
      if (items) (merged[key] as unknown[]).push(...items);
    }
  }
  return merged;
}

class SearchService {
  // Search posts - query is passed raw to backend which parses operators
  async searchPosts(
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchPostResult[]> {
    try {
      const res = await authenticatedClient.get<{ posts?: SearchPostResult[] }>("/search", {
        params: { query, type: "posts" },
        signal,
      });
      return res.data.posts || [];
    } catch (error) {
      return emptyIfSignedOut<SearchPostResult>(error, "posts");
    }
  }

  // Paginated posts search — `/search` keyset-paginates by `_id` behind an opaque
  // `cursor`, returning `hasMore` + the `nextCursor` for the following page. The
  // cursor sort (`createdAt desc`) makes paging stable, so appended pages never
  // duplicate a prior page's rows. Drives the infinite Posts tab.
  async searchPostsPage(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SearchPostsPage> {
    try {
      const params: Record<string, string> = { query, type: "posts" };
      if (cursor) params.cursor = cursor;
      const res = await authenticatedClient.get<{ posts?: SearchPostResult[]; hasMore?: boolean; nextCursor?: string }>(
        "/search",
        { params, signal },
      );
      return {
        posts: res.data.posts ?? [],
        hasMore: res.data.hasMore ?? false,
        nextCursor: res.data.nextCursor,
      };
    } catch (error) {
      return { posts: emptyIfSignedOut<SearchPostResult>(error, "posts"), hasMore: false };
    }
  }

  // Search users via Oxy services
  async searchUsers(query: string, signal?: AbortSignal): Promise<SearchUserResult[]> {
    try {
      const { data } = await searchProfilesCancellable(query, { limit: 20 }, signal);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger.warn("Profile search failed, falling back to exact username lookup", { error });

      // Fallback: an exact username match still gives the viewer something useful.
      // A miss on the fallback is a real failure — let it propagate.
      const exactMatch = await oxyServices.getProfileByUsername(query);
      return exactMatch ? [exactMatch] : [];
    }
  }

  // Paginated user search — Oxy's `GET /profiles/search` offset-paginates
  // (`{ limit, offset }` → `{ data, pagination: { offset, limit, hasMore } }`) on
  // a stable native-first sort, so offset paging never repeats a row. Drives the
  // infinite People tab.
  async searchUsersPage(query: string, offset = 0, signal?: AbortSignal): Promise<SearchUsersPage> {
    try {
      const { data, pagination } = await searchProfilesCancellable(
        query,
        { limit: SEARCH_PAGE_LIMIT, offset },
        signal,
      );
      return {
        users: Array.isArray(data) ? data : [],
        hasMore: pagination?.hasMore ?? false,
        nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      // The exact-username fallback only makes sense for the FIRST page — a deeper
      // page has no single match to fall back to, so its failure is real.
      if (offset > 0) throw error;
      logger.warn("Profile search failed, falling back to exact username lookup", { error });
      const exactMatch = await oxyServices.getProfileByUsername(query);
      return { users: exactMatch ? [exactMatch] : [], hasMore: false, nextOffset: SEARCH_PAGE_LIMIT };
    }
  }

  // Paginated feeds search — `GET /feeds` offset-paginates once `limit` is
  // supplied (`{ items, pagination: { offset, limit, hasMore } }`) on a stable
  // `{ updatedAt desc, _id desc }` sort, so offset paging never repeats a row.
  // Drives the infinite Feeds tab.
  async searchFeedsPage(
    query: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<SearchFeedsPage> {
    const res = await publicClient.get<{ items?: SearchFeedResult[]; pagination?: SearchOffsetPagination }>("/feeds", {
      params: { publicOnly: true, search: query, limit: SEARCH_PAGE_LIMIT, offset },
      signal,
    });
    const pagination = res.data.pagination;
    return {
      feeds: res.data.items ?? [],
      hasMore: pagination?.hasMore ?? false,
      nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
    };
  }

  // Paginated lists search — `GET /lists` filters by `search` (name/description)
  // and offset-paginates (`{ items, pagination: { offset, limit, hasMore } }`) on a
  // stable `{ updatedAt desc, _id desc }` sort. Auth-gated: a signed-out viewer
  // 401s → empty (this source has nothing), which is not a search failure. Drives
  // the infinite Lists tab.
  async searchListsPage(
    query: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<SearchListsPage> {
    try {
      const res = await authenticatedClient.get<{ items?: SearchListResult[]; pagination?: SearchOffsetPagination }>("/lists", {
        params: { search: query, limit: SEARCH_PAGE_LIMIT, offset },
        signal,
      });
      const pagination = res.data.pagination;
      return {
        lists: res.data.items ?? [],
        hasMore: pagination?.hasMore ?? false,
        nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
      };
    } catch (error) {
      return {
        lists: emptyIfSignedOut<SearchListResult>(error, "lists"),
        hasMore: false,
        nextOffset: offset + SEARCH_PAGE_LIMIT,
      };
    }
  }

  // Paginated hashtag search — `GET /hashtags/search` offset-paginates
  // (`{ hashtags, pagination: { offset, limit, hasMore } }`) on a stable
  // `{ count desc, tag asc }` sort, so offset paging never repeats a row. Drives
  // the infinite Hashtags tab.
  async searchHashtagsPage(
    query: string,
    offset = 0,
    signal?: AbortSignal,
  ): Promise<SearchHashtagsPage> {
    const res = await authenticatedClient.get<{ hashtags?: SearchHashtagResult[]; pagination?: SearchOffsetPagination }>("/hashtags/search", {
      params: { query, limit: SEARCH_PAGE_LIMIT, offset },
      signal,
    });
    const pagination = res.data.pagination;
    return {
      hashtags: res.data.hashtags ?? [],
      hasMore: pagination?.hasMore ?? false,
      nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
    };
  }

  // Paginated starter-pack search — `GET /starter-packs` page-paginates
  // (`{ page, limit }` → `{ items, total, page, totalPages }`) on a stable,
  // TOTAL sort (`useCount desc, createdAt desc, _id desc`), so page paging never
  // repeats a row. Drives the infinite Starter Packs tab.
  async searchStarterPacksPage(
    query: string,
    page = 1,
    signal?: AbortSignal,
  ): Promise<SearchStarterPacksPage> {
    const res = await publicClient.get<StarterPackListResponse>("/starter-packs", {
      params: { search: query, limit: SEARCH_PAGE_LIMIT, page },
      signal,
    });
    const currentPage = res.data.page ?? page;
    // Prefer the explicit `hasMore`. A search no longer computes `totalPages`
    // (the `count(*)` behind it scanned the same unindexed predicate the page
    // query already walked), so deriving paging from a total would read "not
    // counted" as "no more pages" and silently stop the infinite scroll after
    // one page. The total-based form stays as the fallback for an older server.
    return {
      starterPacks: res.data.items ?? [],
      hasMore: res.data.hasMore ?? currentPage < (res.data.totalPages ?? 0),
      nextPage: currentPage + 1,
    };
  }

  // Search saved posts
  async searchSaved(
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchPostResult[]> {
    try {
      const response = await feedService.getSavedPosts({
        page: 1,
        limit: 20,
        search: query,
        signal,
      });
      const data = response.data;
      return isRecord(data) && Array.isArray(data.posts)
        ? data.posts.filter(isHydratedPost)
        : [];
    } catch (error) {
      return emptyIfSignedOut<SearchPostResult>(error, "saved");
    }
  }

  // Paginated saved-posts search — `GET /posts/saved` page-paginates
  // (`{ page, limit }` → `{ posts, hasMore }`). Drives the infinite Saved tab.
  async searchSavedPage(
    query: string,
    page = 1,
    signal?: AbortSignal,
  ): Promise<SearchSavedPage> {
    try {
      const response = await feedService.getSavedPosts({
        page,
        limit: SEARCH_PAGE_LIMIT,
        search: query,
        signal,
      });
      const data = response.data;
      const posts = isRecord(data) && Array.isArray(data.posts) ? data.posts.filter(isHydratedPost) : [];
      return { posts, hasMore: isRecord(data) ? Boolean(data.hasMore) : false, nextPage: page + 1 };
    } catch (error) {
      return { posts: emptyIfSignedOut<SearchPostResult>(error, "saved"), hasMore: false, nextPage: page + 1 };
    }
  }

  /**
   * The overview's four server-assembled lanes, in ONE request.
   *
   * `GET /search/overview` replaces four of the seven this screen used to fire —
   * hashtags, lists, public feeds and starter packs — and does the fan-out
   * server-side, where the lanes share one viewer-context resolution and one
   * owner-profile batch instead of resolving their own.
   *
   * It is on the PUBLIC api, so unlike `/search` and `/lists` it answers a
   * signed-out viewer with real results rather than a 401. `canUsePrivateApi`
   * therefore does not gate it.
   *
   * A lane that failed server-side arrives as `error` / `timeout` rather than as
   * an empty array, which is the distinction this client used to destroy: its
   * `allSettled` collapsed a rejected source into an empty section, so an outage
   * rendered as a confident "no results". Those are logged and surfaced as an
   * empty section for now — the section-level UI to say "this part is
   * unavailable" is a separate change — but the information reaches the client,
   * which it previously could not.
   */
  private async searchOverview(
    query: string,
    signal?: AbortSignal,
  ): Promise<Pick<SearchResults, 'feeds' | 'hashtags' | 'lists' | 'starterPacks'>> {
    const res = await publicClient.get<SearchOverviewResponse>("/search/overview", {
      params: { q: query },
      signal,
    });
    const lanes = res.data?.lanes;
    if (!lanes) throw new Error("Unexpected search overview response");

    const laneItems = <T>(name: keyof SearchOverviewResponse['lanes']): T[] => {
      const lane = lanes[name];
      if (!lane) return [];
      if (lane.status === 'error' || lane.status === 'timeout') {
        logger.warn("A search lane did not complete", { lane: name, status: lane.status });
        return [];
      }
      return (lane.items ?? []) as T[];
    };

    return {
      feeds: laneItems<SearchFeedResult>('feeds'),
      hashtags: laneItems<SearchHashtagResult>('hashtags'),
      lists: laneItems<SearchListResult>('lists'),
      starterPacks: laneItems<SearchStarterPackResult>('starterPacks'),
    };
  }

  // Search all — the "All" tab's fan-out, awaited as ONE answer.
  //
  // The screen does not use this: it runs each of `searchAllSources` as its own
  // query (`searchAllSource`) and renders each section as it lands, because one
  // slow source — the posts search, typically — must not hold people and
  // hashtags that answered seconds earlier (issue #1140). This is the same
  // fan-out for a caller that wants the combined answer, built from the same
  // pieces so the two cannot disagree about which sources run or what counts as
  // a failure.
  async searchAll(
    query: string,
    canUsePrivateApi: boolean,
    signal?: AbortSignal,
  ): Promise<SearchResults> {
    const sources = searchAllSources(canUsePrivateApi);
    const settled = await Promise.allSettled(
      sources.map((source) => this.searchAllSource(source, query, signal)),
    );

    const rejections = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    for (const rejection of rejections) {
      logger.warn("A search source failed", { error: rejection.reason });
    }
    // One flaky source degrades to its sections being empty; only a TOTAL
    // failure of the sources that actually ran is an error.
    const firstRejection = rejections[0];
    if (firstRejection && rejections.length === sources.length) {
      throw firstRejection.reason;
    }

    return mergeSearchResults(
      settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
    );
  }

  /**
   * One source of the "All" tab, as the sections it fills.
   *
   * FOUR sources, not seven: the overview carries hashtags, lists, feeds and
   * starter packs together, leaving people (Oxy's own endpoint) and the two
   * post-bearing sources on their own. Which of them run is
   * {@link searchAllSources}'s call.
   */
  async searchAllSource(
    source: SearchAllSource,
    query: string,
    signal?: AbortSignal,
  ): Promise<SearchResults> {
    switch (source) {
      case 'users':
        return { users: await this.searchUsers(query, signal) };
      case 'overview':
        return this.searchOverview(query, signal);
      case 'posts':
        return { posts: await this.searchPosts(query, signal) };
      case 'saved':
        return { saved: await this.searchSaved(query, signal) };
    }
  }

  // --- Search history ---

  async getSearchHistory(viewerId?: ViewerId): Promise<string[]> {
    const history = await Storage.get<string[]>(getSearchHistoryStorageKey(viewerId));
    return history || [];
  }

  async addToSearchHistory(query: string, viewerId?: ViewerId): Promise<string[]> {
    const trimmed = query.trim();
    if (!trimmed) return this.getSearchHistory(viewerId);

    let history = await this.getSearchHistory(viewerId);
    // Remove duplicate if exists
    history = history.filter(item => item !== trimmed);
    // Add to front
    history.unshift(trimmed);
    // Keep only last N
    history = history.slice(0, MAX_SEARCH_HISTORY);
    await Storage.set(getSearchHistoryStorageKey(viewerId), history);
    return history;
  }

  async removeFromSearchHistory(query: string, viewerId?: ViewerId): Promise<string[]> {
    let history = await this.getSearchHistory(viewerId);
    history = history.filter(item => item !== query);
    await Storage.set(getSearchHistoryStorageKey(viewerId), history);
    return history;
  }

  async clearSearchHistory(viewerId?: ViewerId): Promise<void> {
    await Storage.remove(getSearchHistoryStorageKey(viewerId));
  }
}

export const searchService = new SearchService();
