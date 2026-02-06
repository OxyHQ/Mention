import { authenticatedClient } from "@/utils/api";

export interface TrendingTopic {
  type: string;
  name: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
  timeWindow: string;
}

class TrendingService {
  async getTrending(timeWindow: string = '24h', limit: number = 20): Promise<TrendingTopic[]> {
    try {
      const res = await authenticatedClient.get("/trending", {
        params: { timeWindow, limit }
      });
      return res.data.data || res.data || [];
    } catch (error) {
      console.warn("Failed fetching trending", error);
      return [];
    }
  }
}

export const trendingService = new TrendingService();
