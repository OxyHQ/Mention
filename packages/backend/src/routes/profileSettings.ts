import { Router } from 'express';
import UserSettings from '../models/UserSettings';
import UserBehavior from '../models/UserBehavior';
import Block from '../models/Block';
import Restrict from '../models/Restrict';

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

    const { appearance, profileHeaderImage, privacy } = req.body || {};

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
    if (privacy) {
      // Build privacy update object - only include fields that are provided
      // Use dot notation for MongoDB to update nested fields without replacing entire object
      if (privacy.profileVisibility && ['public', 'private', 'followers_only'].includes(privacy.profileVisibility)) {
        update['privacy.profileVisibility'] = privacy.profileVisibility;
      }
      if (typeof privacy.showContactInfo === 'boolean') {
        update['privacy.showContactInfo'] = privacy.showContactInfo;
      }
      if (typeof privacy.allowTags === 'boolean') {
        update['privacy.allowTags'] = privacy.allowTags;
      }
      if (typeof privacy.allowMentions === 'boolean') {
        update['privacy.allowMentions'] = privacy.allowMentions;
      }
      if (typeof privacy.showOnlineStatus === 'boolean') {
        update['privacy.showOnlineStatus'] = privacy.showOnlineStatus;
      }
      if (typeof privacy.hideLikeCounts === 'boolean') {
        update['privacy.hideLikeCounts'] = privacy.hideLikeCounts;
      }
      if (typeof privacy.hideShareCounts === 'boolean') {
        update['privacy.hideShareCounts'] = privacy.hideShareCounts;
      }
      if (typeof privacy.hideReplyCounts === 'boolean') {
        update['privacy.hideReplyCounts'] = privacy.hideReplyCounts;
      }
      if (typeof privacy.hideSaveCounts === 'boolean') {
        update['privacy.hideSaveCounts'] = privacy.hideSaveCounts;
      }
      if (Array.isArray(privacy.hiddenWords)) {
        update['privacy.hiddenWords'] = privacy.hiddenWords;
      }
      if (Array.isArray(privacy.restrictedUsers)) {
        update['privacy.restrictedUsers'] = privacy.restrictedUsers;
      }
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

// Block management endpoints
// Get all blocked users
router.get('/blocks', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    console.log('[Blocks API] GET /blocks - User ID:', oxyUserId);
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const blocks = await Block.find({ userId: oxyUserId })
      .sort({ createdAt: -1 })
      .lean();

    console.log('[Blocks API] Found blocks:', blocks.length, blocks);
    const blockedIds = blocks.map(b => b.blockedId);
    console.log('[Blocks API] Returning blocked IDs:', blockedIds);
    return res.json({ blockedUsers: blockedIds });
  } catch (err) {
    console.error('[Blocks API] Error fetching blocked users:', err);
    return res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

// Block a user
router.post('/blocks', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    console.log('[Blocks API] POST /blocks - User ID:', oxyUserId, 'Body:', req.body);
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const { blockedId } = req.body;
    if (!blockedId || typeof blockedId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid blockedId' });
    }

    if (oxyUserId === blockedId) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    // Check if already blocked
    const existing = await Block.findOne({ userId: oxyUserId, blockedId });
    if (existing) {
      console.log('[Blocks API] User already blocked');
      return res.json({ success: true, message: 'User already blocked' });
    }

    // Create block
    const block = await Block.create({ userId: oxyUserId, blockedId });
    console.log('[Blocks API] Block created:', block);

    return res.json({ success: true, message: 'User blocked successfully' });
  } catch (err: any) {
    console.error('[Blocks API] Error blocking user:', err);
    if (err.code === 11000) {
      return res.json({ success: true, message: 'User already blocked' });
    }
    return res.status(500).json({ error: 'Failed to block user' });
  }
});

// Unblock a user
router.delete('/blocks/:blockedId', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const { blockedId } = req.params;
    if (!blockedId) {
      return res.status(400).json({ error: 'Missing blockedId' });
    }

    const result = await Block.findOneAndDelete({ userId: oxyUserId, blockedId });

    if (result) {
      return res.json({ success: true, message: 'User unblocked successfully' });
    } else {
      return res.status(404).json({ error: 'Block not found' });
    }
  } catch (err) {
    console.error('Error unblocking user:', err);
    return res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// Restricted users management endpoints
// Get all restricted users
router.get('/restricts', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    console.log('[Restricts API] GET /restricts - User ID:', oxyUserId);
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const restricts = await Restrict.find({ userId: oxyUserId })
      .sort({ createdAt: -1 })
      .lean();

    console.log('[Restricts API] Found restricts:', restricts.length, restricts);
    const restrictedIds = restricts.map(r => r.restrictedId);
    console.log('[Restricts API] Returning restricted IDs:', restrictedIds);
    return res.json({ restrictedUsers: restrictedIds });
  } catch (err) {
    console.error('[Restricts API] Error fetching restricted users:', err);
    return res.status(500).json({ error: 'Failed to fetch restricted users' });
  }
});

// Restrict a user
router.post('/restricts', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    console.log('[Restricts API] POST /restricts - User ID:', oxyUserId, 'Body:', req.body);
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const { restrictedId } = req.body;
    if (!restrictedId || typeof restrictedId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid restrictedId' });
    }

    if (oxyUserId === restrictedId) {
      return res.status(400).json({ error: 'Cannot restrict yourself' });
    }

    // Check if already restricted
    const existing = await Restrict.findOne({ userId: oxyUserId, restrictedId });
    if (existing) {
      console.log('[Restricts API] User already restricted');
      return res.json({ success: true, message: 'User already restricted' });
    }

    // Create restrict
    const restrict = await Restrict.create({ userId: oxyUserId, restrictedId });
    console.log('[Restricts API] Restrict created:', restrict);

    return res.json({ success: true, message: 'User restricted successfully' });
  } catch (err: any) {
    console.error('[Restricts API] Error restricting user:', err);
    if (err.code === 11000) {
      return res.json({ success: true, message: 'User already restricted' });
    }
    return res.status(500).json({ error: 'Failed to restrict user' });
  }
});

// Unrestrict a user
router.delete('/restricts/:restrictedId', async (req: any, res) => {
  try {
    const oxyUserId = req.user?.id;
    if (!oxyUserId) return res.status(401).json({ error: 'Unauthorized' });

    const { restrictedId } = req.params;
    if (!restrictedId) {
      return res.status(400).json({ error: 'Missing restrictedId' });
    }

    const result = await Restrict.findOneAndDelete({ userId: oxyUserId, restrictedId });

    if (result) {
      return res.json({ success: true, message: 'User unrestricted successfully' });
    } else {
      return res.status(404).json({ error: 'Restrict not found' });
    }
  } catch (err) {
    console.error('Error unrestricting user:', err);
    return res.status(500).json({ error: 'Failed to unrestrict user' });
  }
});

export default router;

