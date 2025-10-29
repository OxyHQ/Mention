import { authenticatedClient } from "@/utils/api";
import { OxyServices } from "@oxyhq/services";

const oxyServices = new OxyServices({ baseURL: "https://cloud.oxy.so" });

export interface SearchResults {
  posts?: any[];
  hashtags?: any[];
  feeds?: any[];
  users?: any[];
  lists?: any[];
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
      // Use Oxy API to search users
      const results = await oxyServices.getProfileByUsername(query);
      return results ? [results] : [];
    } catch (error) {
      // If exact match fails, return empty array
      // TODO: Implement proper user search when available in OxyServices
      console.warn("Failed searching users", error);
      return [];
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
      console.warn("Failed searching hashtags", error);
      return [];
    }
  }

  // Search all
  async searchAll(query: string): Promise<SearchResults> {
    try {
      const [posts, users, feeds, lists, hashtags] = await Promise.all([
        this.searchPosts(query),
        this.searchUsers(query),
        this.searchFeeds(query),
        this.searchLists(query),
        this.searchHashtags(query)
      ]);

      return { posts, users, feeds, lists, hashtags };
    } catch (error) {
      console.warn("Failed searching all", error);
      return {};
    }
  }
}

export const searchService = new SearchService();
