/**
 * Test script to verify UserBehavior creation
 * Run with: npm run test:behavior or ts-node --transpile-only src/scripts/testUserBehavior.ts
 */

import mongoose from 'mongoose';
import UserBehavior from '../models/UserBehavior';
import { Post } from '../models/Post';
import { userPreferenceService } from '../services/UserPreferenceService';
import dotenv from 'dotenv';

dotenv.config();

async function testUserBehavior() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || '');
    console.log('✅ Connected to MongoDB');

    // Check existing UserBehavior records
    const existingCount = await UserBehavior.countDocuments();
    console.log(`📊 Existing UserBehavior records: ${existingCount}`);

    // Find a test user (get from any post)
    const samplePost = await Post.findOne().lean();
    if (!samplePost) {
      console.log('❌ No posts found. Create a post first.');
      return;
    }

    const testUserId = samplePost.oxyUserId;
    console.log(`🧪 Testing with user ID: ${testUserId}`);

    // Test: Create/update UserBehavior by recording an interaction
    console.log(`\n🔄 Testing recordInteraction...`);
    await userPreferenceService.recordInteraction(testUserId, samplePost._id.toString(), 'like');
    console.log(`✅ recordInteraction completed`);

    // Check if UserBehavior was created
    const userBehavior = await UserBehavior.findOne({ oxyUserId: testUserId }).lean();
    if (userBehavior) {
      console.log(`\n✅ UserBehavior record found!`);
      console.log(`   - Oxy User ID: ${userBehavior.oxyUserId}`);
      console.log(`   - Preferred Authors: ${userBehavior.preferredAuthors?.length || 0}`);
      console.log(`   - Preferred Topics: ${userBehavior.preferredTopics?.length || 0}`);
      console.log(`   - Last Updated: ${userBehavior.lastUpdated}`);
      
      if (userBehavior.preferredAuthors && userBehavior.preferredAuthors.length > 0) {
        console.log(`   - Top Author: ${userBehavior.preferredAuthors[0].authorId} (weight: ${userBehavior.preferredAuthors[0].weight})`);
      }
    } else {
      console.log(`❌ UserBehavior record NOT found after recordInteraction`);
    }

    // Final count
    const finalCount = await UserBehavior.countDocuments();
    console.log(`\n📊 Final UserBehavior records: ${finalCount}`);

  } catch (error) {
    console.error('❌ Error:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  }
}

// Run the test
if (require.main === module) {
  testUserBehavior().catch(console.error);
}

export default testUserBehavior;

