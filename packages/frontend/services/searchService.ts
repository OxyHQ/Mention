import { authenticatedClient } from "@/utils/api";
import { oxyServices } from "@/lib/oxyServices";
import { feedService } from "./feedService";

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

class SearchService {
  // Search posts
  async searchPosts(query: string): Promise<any[]> {
    try {
      const res = await authenticatedClient.get("/search", {
        params: { query, type: "posts" }
      });
      return res.data.posts || [];
    } catch (error) {
      console.warn("Failed searching posts", error);
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
      console.warn("Failed searching users", error);
      
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
      console.warn("Failed searching feeds", error);
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
      console.warn("Failed searching lists", error);
      return [];
    }
  }

  // Search hashtags
  async searchHashtags(query: string): Promise<any[]> {
    try {
      const res = await authenticatedClient.get("/hashtags", {
        params: { search: query }
      });
      return res.data.hashtags || [];
    } catch (error) {
      // Silently return empty array on error
      return [];
    }
  }

  // Search saved posts
  async searchSaved(query: string): Promise<any[]> {
    try {
      const response = await feedService.getSavedPosts({ 
        page: 1, 
        limit: 20,
        search: query 
      });
      return response.data.posts || [];
    } catch (error) {
      console.warn("Failed searching saved posts", error);
      return [];
    }
  }

  // Search all
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
      console.warn("Failed searching all", error);
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
      console.warn("Failed advanced search", error);
      return { posts: [], hasMore: false };
    }
  }
}

export const searchService = new SearchService();
