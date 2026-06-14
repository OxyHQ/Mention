/**
 * Test script to verify UserBehavior creation
 * Run with: bun src/scripts/testUserBehavior.ts
 */

import mongoose from 'mongoose';
import UserBehavior from '../models/UserBehavior';
import { Post } from '../models/Post';
import { userPreferenceService } from '../services/UserPreferenceService';
import { logger } from '../utils/logger';

async function testUserBehavior() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || '');
    logger.info('Connected to MongoDB');

    // Check existing UserBehavior records
    const existingCount = await UserBehavior.countDocuments();
    logger.info(`Existing UserBehavior records: ${existingCount}`);

    // Find a test user (get from any post)
    const samplePost = await Post.findOne().lean();
    if (!samplePost) {
      logger.warn('No posts found. Create a post first.');
      return;
    }

    const testUserId = samplePost.oxyUserId;
    logger.info(`Testing with user ID: ${testUserId}`);

    // Test: Create/update UserBehavior by recording an interaction
    logger.info('Testing recordInteraction...');
    await userPreferenceService.recordInteraction(testUserId!, samplePost._id.toString(), 'like');
    logger.info('recordInteraction completed');

    // Check if UserBehavior was created
    const userBehavior = await UserBehavior.findOne({ oxyUserId: testUserId }).lean();
    if (userBehavior) {
      const topAuthor = userBehavior.preferredAuthors?.[0];
      logger.info('UserBehavior record found', {
        oxyUserId: userBehavior.oxyUserId,
        preferredAuthors: userBehavior.preferredAuthors?.length || 0,
        preferredTopics: userBehavior.preferredTopics?.length || 0,
        lastUpdated: userBehavior.lastUpdated,
        topAuthor: topAuthor
          ? { authorId: topAuthor.authorId, weight: topAuthor.weight }
          : undefined,
      });
    } else {
      logger.warn('UserBehavior record NOT found after recordInteraction');
    }

    // Final count
    const finalCount = await UserBehavior.countDocuments();
    logger.info(`Final UserBehavior records: ${finalCount}`);

  } catch (error) {
    logger.error('testUserBehavior failed', error);
  } finally {
    await mongoose.disconnect();
    logger.info('Disconnected from MongoDB');
  }
}

// Run the test
if (require.main === module) {
  testUserBehavior().catch((error) => logger.error('testUserBehavior crashed', error));
}

export default testUserBehavior;

