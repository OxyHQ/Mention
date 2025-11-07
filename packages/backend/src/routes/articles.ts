import { Router } from 'express';
import { getArticle } from '../controllers/articles.controller';

const router = Router();

router.get('/:id', getArticle);

export default router;

