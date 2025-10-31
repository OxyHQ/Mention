import { Router } from 'express';
import UserSettings from '../models/UserSettings';
import UserBehavior from '../models/UserBehavior';

const router = Router();

// Helper: ensure a settings doc exists for a user
async function getOrCreate(oxyUserId: string) {
  let doc = await UserSettings.findOne({ oxyUserId }).lean();
  if (!doc) {
    doc = (await UserSettings.create({ oxyUserId })).toObject();
  }
  return doc;
}

// Get current user's settings
router.get('/settings/me', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });
    const doc = await getOrCreate(oxyUserId);
    return res.json(doc);
  } catch (err) {
    console.error('Error fetching my settings:', err);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Get settings by oxy user id (public to authenticated users)
router.get('/settings/:userId', async (req, res) => {
  try {
    const { userId } = req.params as any;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    const doc = await getOrCreate(userId);
    return res.json(doc);
  } catch (err) {
    console.error('Error fetching user settings:', err);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update current user's settings
router.put('/settings', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const { appearance, profileHeaderImage } = req.body || {};

    const update: any = {};
    if (appearance) {
      update['appearance'] = {};
      if (appearance.themeMode && ['light', 'dark', 'system'].includes(appearance.themeMode)) {
        update.appearance.themeMode = appearance.themeMode;
      }
      if (typeof appearance.primaryColor === 'string' && appearance.primaryColor.trim()) {
        update.appearance.primaryColor = appearance.primaryColor.trim();
      } else if (appearance.primaryColor === null) {
        update.appearance.primaryColor = undefined;
      }
    }
    if (typeof profileHeaderImage === 'string') {
      update.profileHeaderImage = profileHeaderImage;
    }

    const doc = await UserSettings.findOneAndUpdate(
      { oxyUserId },
      { $set: update },
      { upsert: true, new: true }
    ).lean();

    return res.json(doc);
  } catch (err) {
    console.error('Error updating settings:', err);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Reset user behavior/preferences (clear personalization data)
router.delete('/settings/behavior', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    // Delete or reset UserBehavior record
    const result = await UserBehavior.findOneAndDelete({ oxyUserId });

    if (result) {
      console.log(`[Settings] UserBehavior reset for user ${oxyUserId}`);
      return res.json({ 
        success: true, 
        message: 'Personalization data reset successfully' 
      });
    } else {
      // No UserBehavior record exists, return success anyway
      return res.json({ 
        success: true, 
        message: 'No personalization data to reset' 
      });
    }
  } catch (err) {
    console.error('Error resetting user behavior:', err);
    return res.status(500).json({ error: 'Failed to reset personalization data' });
  }
});

export default router;

