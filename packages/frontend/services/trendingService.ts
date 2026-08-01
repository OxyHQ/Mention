import type { PostUser, TrendCategory, TrendEventInput, TrendStatus } from "@mention/shared-types";
import { logger } from '@oxyhq/core/logger';
import { authenticatedClient, publicClient } from "@/utils/api";

export interface TrendingTopic {
  type: string;
  /** The term — the retrieval key. Render `displayName`, not this. */
  name: string;
  /** Human label. Absent on rows written before trends were labelled. */
  displayName?: string;
  category?: TrendCategory;
  description: string;
  score: number;
  volume: number;
  /** Distinct authors. Absent on rows that predate the field. */
  authorCount?: number;
  momentum: number;
  /** ISO onset of the current run. Absent on rows that predate onset tracking. */
  startedAt?: string;
  status?: TrendStatus;
  /** Server-resolved faces. Absent when none resolved. */
  actors?: PostUser[];
  rank: number;
  calculatedAt: string;
}

export interface TrendingDay {
  date: string;
  trends: TrendingTopic[];
}

class TrendingService {

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
   * The generated summary for a trend, if it has earned one
   * (`GET /trending/summary`).
   *
   * Calling this IS the demand signal — the server counts the open and only
   * generates a summary once a trend has been opened enough times. So it is
   * called on the trend screen and NOWHERE else: firing it from a list would
   * count opens that never happened and pay for prose nobody asked for.
   *
   * Public client, same as the event report: `/trending` is public and this
   * screen renders for signed-out visitors.
   *
   * Swallows its own failures — a missing summary is the ordinary case, so a
   * failed lookup must be indistinguishable from one that simply has none.
   */
  async getTrendSummary(term: string): Promise<string | undefined> {
    try {
      const res = await publicClient.get<{ description?: string }>("/trending/summary", {
        params: { term },
      });
      return res.data.description;
    } catch (error) {
      logger.debug("Failed to fetch trend summary", { term, error });
      return undefined;
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
