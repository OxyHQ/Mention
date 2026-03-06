import { authenticatedClient } from '@/utils/api';

class ArticleService {
  async getArticle(articleId: string): Promise<{ id: string; postId?: string; title?: string; body?: string }> {
    const response = await authenticatedClient.get(`/articles/${articleId}`);
    return response.data;
  }
}

export const articleService = new ArticleService();

