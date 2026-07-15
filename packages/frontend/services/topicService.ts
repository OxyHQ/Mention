import { authenticatedClient } from "@/utils/api";
import { logger } from "@/lib/logger";
import { TopicData, TopicType } from "@oxyhq/core";

class TopicService {
  async getCategories(locale?: string): Promise<TopicData[]> {
    try {
      const res = await authenticatedClient.get<{ topics?: TopicData[] }>("/topics/categories", {
        params: locale ? { locale } : undefined,
      });
      return res.data.topics || [];
    } catch (error) {
      logger.warn("Failed fetching topic categories", { error });
      return [];
    }
  }

  async search(query: string, limit: number = 10): Promise<TopicData[]> {
    try {
      const res = await authenticatedClient.get<{ topics?: TopicData[] }>("/topics/search", {
        params: { q: query, limit },
      });
      return res.data.topics || [];
    } catch (error) {
      logger.warn("Failed searching topics", { error });
      return [];
    }
  }

  async list(options?: {
    type?: TopicType;
    q?: string;
    limit?: number;
    offset?: number;
    locale?: string;
  }): Promise<{ topics: TopicData[]; total: number }> {
    try {
      const res = await authenticatedClient.get<{ topics: TopicData[]; total: number }>("/topics", { params: options });
      return res.data;
    } catch (error) {
      logger.warn("Failed listing topics", { error });
      return { topics: [], total: 0 };
    }
  }

  async getBySlug(slug: string): Promise<TopicData | null> {
    try {
      const res = await authenticatedClient.get<TopicData>(`/topics/${slug}`);
      return res.data;
    } catch (error) {
      logger.warn("Failed fetching topic by slug", { error, slug });
      return null;
    }
  }
}

export const topicService = new TopicService();
