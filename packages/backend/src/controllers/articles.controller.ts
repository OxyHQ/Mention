import { Request, Response } from 'express';
import ArticleModel from '../models/Article';
import { logger } from '../utils/logger';

export const getArticle = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const article = await ArticleModel.findById(id);
    if (!article) {
      return res.status(404).json({ message: 'Article not found' });
    }

    return res.json({
      id: String(article._id),
      postId: article.postId,
      title: article.title,
      body: article.body,
      createdBy: article.createdBy,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    });
  } catch (error) {
    logger.error('[Articles] Error fetching article:', error);
    return res.status(500).json({ message: 'Error fetching article', error });
  }
};

