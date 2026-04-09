import { Router } from 'express';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/ready', (_req, res) => {
  res.status(200).json({ status: 'ready' });
});

export default router;
