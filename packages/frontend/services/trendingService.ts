import { logger } from "@/lib/logger";
import { authenticatedClient } from "@/utils/api";

export interface TrendingTopic {
  type: string;
  name: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  rank: number;
  calculatedAt: string;
}

export interface TrendingBatch {
  calculatedAt: string;
  trends: TrendingTopic[];
}

class TrendingService {
  async getTrending(limit: number = 20, type?: string): Promise<TrendingTopic[]> {
    try {
      const params: Record<string, string | number> = { limit };
      if (type) params.type = type;

      const res = await authenticatedClient.get("/trending", { params });
      return res.data.trending || [];
    } catch (error) {
      logger.warn("Failed fetching trending", { error });
      return [];
    }
  }

  async getTrendingHistory(page: number = 1, limit: number = 10): Promise<{
    batches: TrendingBatch[];
    page: number;
    totalPages: number;
  }> {
    try {
      const res = await authenticatedClient.get("/trending/history", {
        params: { page, limit },
      });
      return res.data;
    } catch (error) {
      logger.warn("Failed fetching trending history", { error });
      return { batches: [], page, totalPages: 0 };
    }
  }
}

export const trendingService = new TrendingService();
