/**
 * Test script to verify UserBehavior creation
 * Run with: npm run test:behavior or ts-node --transpile-only src/scripts/testUserBehavior.ts
 */

import mongoose from 'mongoose';
import UserBehavior from '../models/UserBehavior';
import { Post } from '../models/Post';
import { userPreferenceService } from '../services/UserPreferenceService';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';

dotenv.config();

async function testUserBehavior() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || '');
    logger.info('✅ Connected to MongoDB');

    // Check existing UserBehavior records
    const existingCount = await UserBehavior.countDocuments();
    logger.info(`📊 Existing UserBehavior records: ${existingCount}`);

    // Find a test user (get from any post)
    const samplePost = await Post.findOne().lean();
    if (!samplePost) {
      logger.info('❌ No posts found. Create a post first.');
      return;
    }

    const testUserId = samplePost.oxyUserId;
    logger.info(`🧪 Testing with user ID: ${testUserId}`);

    // Test: Create/update UserBehavior by recording an interaction
    logger.info(`\n🔄 Testing recordInteraction...`);
    await userPreferenceService.recordInteraction(testUserId, samplePost._id.toString(), 'like');
    logger.info(`✅ recordInteraction completed`);

    // Check if UserBehavior was created
    const userBehavior = await UserBehavior.findOne({ oxyUserId: testUserId }).lean();
    if (userBehavior) {
      logger.info(`\n✅ UserBehavior record found!`);
      logger.info(`   - Oxy User ID: ${userBehavior.oxyUserId}`);
      logger.info(`   - Preferred Authors: ${userBehavior.preferredAuthors?.length || 0}`);
      logger.info(`   - Preferred Topics: ${userBehavior.preferredTopics?.length || 0}`);
      logger.info(`   - Last Updated: ${userBehavior.lastUpdated}`);
      
      if (userBehavior.preferredAuthors && userBehavior.preferredAuthors.length > 0) {
        logger.info(`   - Top Author: ${userBehavior.preferredAuthors[0].authorId} (weight: ${userBehavior.preferredAuthors[0].weight})`);
      }
    } else {
      logger.info(`❌ UserBehavior record NOT found after recordInteraction`);
    }

    // Final count
    const finalCount = await UserBehavior.countDocuments();
    logger.info(`\n📊 Final UserBehavior records: ${finalCount}`);

  } catch (error) {
    logger.error('❌ Error:', error);
    if (error instanceof Error) {
      logger.error('Stack:', error.stack);
    }
  } finally {
    await mongoose.disconnect();
    logger.info('\n✅ Disconnected from MongoDB');
  }
}

// Run the test
if (require.main === module) {
  testUserBehavior().catch((error) => {
    logger.error('Unhandled error:', error);
    process.exit(1);
  });
}

export default testUserBehavior;

