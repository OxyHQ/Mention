import { createScopedLogger } from "@/lib/logger";
import { authenticatedClient } from "@/utils/api";
import { oxyServices } from "@/lib/oxyServices";
import { feedService } from "./feedService";
import { Storage } from "@/utils/storage";

const logger = createScopedLogger('SearchService');

export interface SearchResults {
  posts?: any[];
  hashtags?: any[];
  feeds?: any[];
  users?: any[];
  lists?: any[];
  saved?: any[];
}

export interface SearchFilters {
  dateFrom?: string;
  dateTo?: string;
  author?: string;
  minLikes?: number;
  minReposts?: number;
  mediaType?: 'image' | 'video' | 'gif';
  hasMedia?: boolean;
  language?: string;
  cursor?: string;
  limit?: number;
}

const SEARCH_HISTORY_KEY = 'mention_search_history';
const MAX_SEARCH_HISTORY = 10;

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
  { operator: 'min_reposts:N', description: 'Minimum reposts' },
] as const;

class SearchService {
  // Search posts - query is passed raw to backend which parses operators
  async searchPosts(query: string): Promise<any[]> {
    try {
      const res = await authenticatedClient.get("/search", {
        params: { query, type: "posts" }
      });
      return res.data.posts || [];
    } catch (error) {
      logger.warn("Failed searching posts", { error });
      return [];
    }
  }

  // Search users via Oxy services
  async searchUsers(query: string): Promise<any[]> {
    try {
      // Use OxyServices searchProfiles method
      const { data } = await oxyServices.searchProfiles(query, { limit: 20 });
      if (Array.isArray(data)) {
        return data;
      }
      return [];
    } catch (error) {
      logger.warn("Failed searching users", { error });

      // Fallback: try to get exact username match
      try {
        const exactMatch = await oxyServices.getProfileByUsername(query);
        return exactMatch ? [exactMatch] : [];
      } catch (e) {
        return [];
      }
    }
  }

  // Search feeds
  async searchFeeds(query: string): Promise<any[]> {
    try {
      const res = await authenticatedClient.get("/feeds", {
        params: { publicOnly: true, search: query }
      });
      return res.data.items || [];
    } catch (error) {
      logger.warn("Failed searching feeds", { error });
      return [];
    }
  }

  // Search lists
  async searchLists(query: string): Promise<any[]> {
    try {
      const res = await authenticatedClient.get("/lists", {
        params: { search: query }
      });
      return res.data.items || [];
    } catch (error) {
      logger.warn("Failed searching lists", { error });
      return [];
    }
  }

  // Search hashtags — backend exposes POST /hashtags/search with body { query }
  async searchHashtags(query: string): Promise<any[]> {
    try {
      const res = await authenticatedClient.post("/hashtags/search", { query });
      return res.data.data || [];
    } catch (error) {
      // Silently return empty array on error
      return [];
    }
  }

  // Search saved posts
  async searchSaved(query: string): Promise<unknown[]> {
    try {
      const response = await feedService.getSavedPosts({
        page: 1,
        limit: 20,
        search: query
      });
      const data = response.data as { posts?: unknown[] } | undefined;
      return data?.posts ?? [];
    } catch (error) {
      logger.warn("Failed searching saved posts", { error });
      return [];
    }
  }

  // Search all - shows users above posts in "all" tab
  async searchAll(query: string): Promise<SearchResults> {
    try {
      const [posts, users, feeds, lists, hashtags, saved] = await Promise.all([
        this.searchPosts(query),
        this.searchUsers(query),
        this.searchFeeds(query),
        this.searchLists(query),
        this.searchHashtags(query),
        this.searchSaved(query)
      ]);

      return { posts, users, feeds, lists, hashtags, saved };
    } catch (error) {
      logger.warn("Failed searching all", { error });
      return {};
    }
  }

  // Advanced search with filters
  async searchAdvanced(query: string, filters: SearchFilters = {}): Promise<{ posts: any[]; hasMore: boolean; nextCursor?: string }> {
    try {
      const params: any = { query, type: 'posts', ...filters };
      // Remove undefined values
      Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);

      const res = await authenticatedClient.get("/search", { params });
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
