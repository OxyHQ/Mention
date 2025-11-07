import { Request, Response } from 'express';
import ArticleModel from '../models/Article';

export const getArticle = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const article = await ArticleModel.findById(id).lean();
    if (!article) {
      return res.status(404).json({ message: 'Article not found' });
    }

    return res.json({
      id: article._id.toString(),
      postId: article.postId,
      title: article.title,
      body: article.body,
      createdBy: article.createdBy,
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    });
  } catch (error) {
    console.error('Error fetching article:', error);
    return res.status(500).json({ message: 'Error fetching article', error });
  }
};

