import { Router, Request, Response } from 'express';
import { authService } from '../../services/auth.service';
import type { User } from '../../services/auth.service';

const router = Router();

// Register endpoint
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;
    const response = await authService.register({ username, email, password });
    res.json(response);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Login endpoint
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const response = await authService.login(username, password);
    res.json(response);
  } catch (error: any) {
    res.status(401).json({ success: false, message: error.message });
  }
});

// Validate session endpoint
router.get('/validate', async (req: Request, res: Response) => {
  try {
    const isValid = await authService.validateCurrentSession();
    res.json({ valid: isValid });
  } catch (error: any) {
    res.status(401).json({ valid: false, message: error.message });
  }
});

// Refresh token endpoint
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    const tokens = await authService.refreshToken();
    if (!tokens) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }
    res.json(tokens);
  } catch (error: any) {
    res.status(401).json({ success: false, message: error.message });
  }
});

// Logout endpoint
router.post('/logout', async (req: Request, res: Response) => {
  try {
    await authService.logout();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router; 