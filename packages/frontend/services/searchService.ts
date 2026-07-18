import { createScopedLogger } from "@/lib/logger";
import { authenticatedClient, isUnauthorizedError, publicClient } from "@/utils/api";
import { oxyServices } from "@/lib/oxyServices";
import { feedService } from "./feedService";
import { Storage } from "@/utils/storage";
import type { User } from '@oxyhq/core';
import type { HydratedPost } from '@mention/shared-types';

const logger = createScopedLogger('SearchService');

export type SearchPostResult = HydratedPost & { _id?: string };

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
}

export interface SearchFilters {
  dateFrom?: string;
  dateTo?: string;
  minLikes?: number;
  minBoosts?: number;
  mediaType?: 'image' | 'video' | 'gif';
  hasMedia?: boolean;
  language?: string;
  cursor?: string;
  limit?: number;
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

const SEARCH_HISTORY_KEY = 'mention_search_history';
const MAX_SEARCH_HISTORY = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHydratedPost(value: unknown): value is SearchPostResult {
  return isRecord(value) && typeof value.id === 'string' && isRecord(value.content);
}

/**
 * Search operator definitions for display in the UI hint.
 */
export const SEARCH_OPERATORS = [
  { operator: 'from:username', description: 'Posts by a specific user' },
  { operator: 'since:YYYY-MM-DD', description: 'Posts after a date' },
  { operator: 'until:YYYY-MM-DD', description: 'Posts before a date' },
  { operator: 'has:media', description: 'Posts with media' },
  { operator: 'has:links', description: 'Posts with links' },
  { operator: 'min_likes:N', description: 'Minimum likes' },
  { operator: 'min_boosts:N', description: 'Minimum boosts' },
] as const;

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

class SearchService {
  // Search posts - query is passed raw to backend which parses operators
  async searchPosts(query: string): Promise<SearchPostResult[]> {
    try {
      const res = await authenticatedClient.get<{ posts?: SearchPostResult[] }>("/search", {
        params: { query, type: "posts" }
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
  async searchPostsPage(query: string, cursor?: string): Promise<SearchPostsPage> {
    try {
      const params: Record<string, string> = { query, type: "posts" };
      if (cursor) params.cursor = cursor;
      const res = await authenticatedClient.get<{ posts?: SearchPostResult[]; hasMore?: boolean; nextCursor?: string }>(
        "/search",
        { params },
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
  async searchUsers(query: string): Promise<SearchUserResult[]> {
    try {
      // Use OxyServices searchProfiles method
      const { data } = await oxyServices.searchProfiles(query, { limit: 20 });
      return Array.isArray(data) ? data : [];
    } catch (error) {
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
  async searchUsersPage(query: string, offset = 0): Promise<SearchUsersPage> {
    try {
      const { data, pagination } = await oxyServices.searchProfiles(query, {
        limit: SEARCH_PAGE_LIMIT,
        offset,
      });
      return {
        users: Array.isArray(data) ? data : [],
        hasMore: pagination?.hasMore ?? false,
        nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
      };
    } catch (error) {
      // The exact-username fallback only makes sense for the FIRST page — a deeper
      // page has no single match to fall back to, so its failure is real.
      if (offset > 0) throw error;
      logger.warn("Profile search failed, falling back to exact username lookup", { error });
      const exactMatch = await oxyServices.getProfileByUsername(query);
      return { users: exactMatch ? [exactMatch] : [], hasMore: false, nextOffset: SEARCH_PAGE_LIMIT };
    }
  }

  // Search feeds — the compact "All" overview (returns every public match in one
  // shot; the paginated tab uses `searchFeedsPage`).
  async searchFeeds(query: string): Promise<SearchFeedResult[]> {
    const res = await publicClient.get<{ items?: SearchFeedResult[] }>("/feeds", {
      params: { publicOnly: true, search: query }
    });
    return res.data.items || [];
  }

  // Paginated feeds search — `GET /feeds` offset-paginates once `limit` is
  // supplied (`{ items, pagination: { offset, limit, hasMore } }`) on a stable
  // `{ updatedAt desc, _id desc }` sort, so offset paging never repeats a row.
  // Drives the infinite Feeds tab.
  async searchFeedsPage(query: string, offset = 0): Promise<SearchFeedsPage> {
    const res = await publicClient.get<{ items?: SearchFeedResult[]; pagination?: SearchOffsetPagination }>("/feeds", {
      params: { publicOnly: true, search: query, limit: SEARCH_PAGE_LIMIT, offset },
    });
    const pagination = res.data.pagination;
    return {
      feeds: res.data.items ?? [],
      hasMore: pagination?.hasMore ?? false,
      nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
    };
  }

  // Search lists — the compact "All" overview (returns every accessible match in
  // one shot; the paginated tab uses `searchListsPage`).
  async searchLists(query: string): Promise<SearchListResult[]> {
    try {
      const res = await authenticatedClient.get<{ items?: SearchListResult[] }>("/lists", {
        params: { search: query }
      });
      return res.data.items || [];
    } catch (error) {
      return emptyIfSignedOut<SearchListResult>(error, "lists");
    }
  }

  // Paginated lists search — `GET /lists` filters by `search` (name/description)
  // and offset-paginates (`{ items, pagination: { offset, limit, hasMore } }`) on a
  // stable `{ updatedAt desc, _id desc }` sort. Auth-gated: a signed-out viewer
  // 401s → empty (this source has nothing), which is not a search failure. Drives
  // the infinite Lists tab.
  async searchListsPage(query: string, offset = 0): Promise<SearchListsPage> {
    try {
      const res = await authenticatedClient.get<{ items?: SearchListResult[]; pagination?: SearchOffsetPagination }>("/lists", {
        params: { search: query, limit: SEARCH_PAGE_LIMIT, offset },
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

  // Search hashtags — `GET /hashtags/search` answers with each matching tag and
  // the number of posts carrying it, so the result row can show a real count.
  // Compact "All" overview; the paginated tab uses `searchHashtagsPage`.
  async searchHashtags(query: string): Promise<SearchHashtagResult[]> {
    const res = await authenticatedClient.get<{ hashtags?: SearchHashtagResult[] }>("/hashtags/search", {
      params: { query, limit: SEARCH_OVERVIEW_HASHTAG_LIMIT }
    });
    return res.data.hashtags ?? [];
  }

  // Paginated hashtag search — `GET /hashtags/search` offset-paginates
  // (`{ hashtags, pagination: { offset, limit, hasMore } }`) on a stable
  // `{ count desc, tag asc }` sort, so offset paging never repeats a row. Drives
  // the infinite Hashtags tab.
  async searchHashtagsPage(query: string, offset = 0): Promise<SearchHashtagsPage> {
    const res = await authenticatedClient.get<{ hashtags?: SearchHashtagResult[]; pagination?: SearchOffsetPagination }>("/hashtags/search", {
      params: { query, limit: SEARCH_PAGE_LIMIT, offset },
    });
    const pagination = res.data.pagination;
    return {
      hashtags: res.data.hashtags ?? [],
      hasMore: pagination?.hasMore ?? false,
      nextOffset: (pagination?.offset ?? offset) + (pagination?.limit ?? SEARCH_PAGE_LIMIT),
    };
  }

  // Search saved posts
  async searchSaved(query: string): Promise<SearchPostResult[]> {
    try {
      const response = await feedService.getSavedPosts({
        page: 1,
        limit: 20,
        search: query
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
  async searchSavedPage(query: string, page = 1): Promise<SearchSavedPage> {
    try {
      const response = await feedService.getSavedPosts({ page, limit: SEARCH_PAGE_LIMIT, search: query });
      const data = response.data;
      const posts = isRecord(data) && Array.isArray(data.posts) ? data.posts.filter(isHydratedPost) : [];
      return { posts, hasMore: isRecord(data) ? Boolean(data.hasMore) : false, nextPage: page + 1 };
    } catch (error) {
      return { posts: emptyIfSignedOut<SearchPostResult>(error, "saved"), hasMore: false, nextPage: page + 1 };
    }
  }

  // Search all - shows users above posts in "all" tab.
  //
  // The PUBLIC sources (users via Oxy, feeds via the public client, hashtags on
  // the public router) run for every viewer. The AUTH-GATED sources (posts,
  // lists, saved — all behind the authenticated API) only fire once the private
  // API is ready: during the SSO cold-boot the viewer can be authenticated while
  // the private API is still pending, and firing then would 401 (console noise,
  // not a result). Those sections stay empty until the search query refetches on
  // `canUsePrivateApi` flipping true (it is part of the search query key), then
  // fill in. A signed-out viewer keeps them empty for good — a quiet "nothing
  // here", never a 401 storm.
  //
  // One flaky source must not blank the whole screen, so sources settle
  // independently: a partial failure degrades to that section being empty, and
  // only a TOTAL failure of the sources that actually RAN surfaces as an error.
  async searchAll(query: string, canUsePrivateApi: boolean): Promise<SearchResults> {
    const [users, feeds, hashtags, posts, lists, saved] = await Promise.allSettled([
      this.searchUsers(query),
      this.searchFeeds(query),
      this.searchHashtags(query),
      canUsePrivateApi ? this.searchPosts(query) : Promise.resolve<SearchPostResult[]>([]),
      canUsePrivateApi ? this.searchLists(query) : Promise.resolve<SearchListResult[]>([]),
      canUsePrivateApi ? this.searchSaved(query) : Promise.resolve<SearchPostResult[]>([]),
    ]);

    // The gated sources short-circuit to a resolved empty page when the private
    // API isn't ready, so exclude them from the total-failure count — otherwise a
    // signed-out viewer with healthy public sources could never surface a real
    // error, and a fulfilled no-op would mask one.
    const activeSources = canUsePrivateApi
      ? [users, feeds, hashtags, posts, lists, saved]
      : [users, feeds, hashtags];
    const rejections = activeSources.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    for (const rejection of rejections) {
      logger.warn("A search source failed", { error: rejection.reason });
    }
    const firstRejection = rejections[0];
    if (firstRejection && rejections.length === activeSources.length) {
      throw firstRejection.reason;
    }

    const valueOf = <T>(result: PromiseSettledResult<T[]>): T[] =>
      result.status === 'fulfilled' ? result.value : [];

    return {
      posts: valueOf(posts),
      users: valueOf(users),
      feeds: valueOf(feeds),
      lists: valueOf(lists),
      hashtags: valueOf(hashtags),
      saved: valueOf(saved),
    };
  }

  // Advanced search with filters
  async searchAdvanced(query: string, filters: SearchFilters = {}): Promise<{ posts: SearchPostResult[]; hasMore: boolean; nextCursor?: string }> {
    try {
      const params: Record<string, string | number | boolean> = { query, type: 'posts' };
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined) {
          params[key] = value;
        }
      });

      const res = await authenticatedClient.get<{ posts?: SearchPostResult[]; hasMore?: boolean; nextCursor?: string }>("/search", { params });
      return {
        posts: res.data.posts || [],
        hasMore: res.data.hasMore || false,
        nextCursor: res.data.nextCursor
      };
    } catch (error) {
      logger.warn("Failed advanced search", { error });
      return { posts: [], hasMore: false };
    }
  }

  // --- Search history ---

  async getSearchHistory(): Promise<string[]> {
    const history = await Storage.get<string[]>(SEARCH_HISTORY_KEY);
    return history || [];
  }

  async addToSearchHistory(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (!trimmed) return this.getSearchHistory();

    let history = await this.getSearchHistory();
    // Remove duplicate if exists
    history = history.filter(item => item !== trimmed);
    // Add to front
    history.unshift(trimmed);
    // Keep only last N
    history = history.slice(0, MAX_SEARCH_HISTORY);
    await Storage.set(SEARCH_HISTORY_KEY, history);
    return history;
  }

  async removeFromSearchHistory(query: string): Promise<string[]> {
    let history = await this.getSearchHistory();
    history = history.filter(item => item !== query);
    await Storage.set(SEARCH_HISTORY_KEY, history);
    return history;
  }

  async clearSearchHistory(): Promise<void> {
    await Storage.remove(SEARCH_HISTORY_KEY);
  }
}

export const searchService = new SearchService();
