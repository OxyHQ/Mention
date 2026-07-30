import type { TrendEventInput } from "@mention/shared-types";
import { logger } from '@oxyhq/core/logger';
import { authenticatedClient, publicClient } from "@/utils/api";

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

export interface TrendingDay {
  date: string;
  trends: TrendingTopic[];
}

class TrendingService {
  async getTrending(limit: number = 20, type?: string): Promise<TrendingTopic[]> {
    try {
      const params: Record<string, string | number> = { limit };
      if (type) params.type = type;

      const res = await authenticatedClient.get<{ trending?: TrendingTopic[] }>("/trending", { params });
      return res.data.trending || [];
    } catch (error) {
      logger.warn("Failed fetching trending", { error });
      return [];
    }
  }

  async getTrendingHistory(page: number = 1, limit: number = 10): Promise<{
    days: TrendingDay[];
    page: number;
    totalPages: number;
  }> {
    try {
      const res = await authenticatedClient.get<{ days: TrendingDay[]; page: number; totalPages: number }>("/trending/history", {
        params: { page, limit },
      });
      return res.data;
    } catch (error) {
      logger.warn("Failed fetching trending history", { error });
      return { days: [], page, totalPages: 0 };
    }
  }

  /**
   * Report a trend impression or press (`POST /trending/events`).
   *
   * Sent on the PUBLIC client on purpose: `/trending` is public, the right-rail
   * widget renders for signed-out visitors, and the endpoint counts their
   * presses too — routing this through the authenticated client would make an
   * anonymous report depend on a session that is not there.
   *
   * Swallows its own failures, same contract as the other telemetry writes: a
   * lost counter must never reach the reader, but it stays visible in
   * diagnostics.
   */
  async sendTrendEvent(input: TrendEventInput): Promise<void> {
    try {
      await publicClient.post("/trending/events", input);
    } catch (error) {
      logger.debug("Failed to send trend event", { event: input.event, surface: input.surface, error });
    }
  }
}

export const trendingService = new TrendingService();
