/**
 * Migration script to fix posts with missing or incomplete stats
 * Run this once to fix existing posts in the database
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';

async function fixPostStats() {
  try {
    // Connect to MongoDB (use your connection string)
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Find posts with missing or incomplete stats
    const posts = await Post.find({
      $or: [
        { stats: { $exists: false } },
        { 'stats.likesCount': { $exists: false } },
        { 'stats.repostsCount': { $exists: false } },
        { 'stats.commentsCount': { $exists: false } }
      ]
    });

    console.log(`📊 Found ${posts.length} posts with missing stats`);

    let fixed = 0;
    for (const post of posts) {
      const stats: any = post.stats || {};
      const updates: any = {
        'stats.likesCount': typeof stats.likesCount === 'number' ? stats.likesCount : 0,
        'stats.repostsCount': typeof stats.repostsCount === 'number' ? stats.repostsCount : 0,
        'stats.commentsCount': typeof stats.commentsCount === 'number' ? stats.commentsCount : 0,
        'stats.viewsCount': typeof stats.viewsCount === 'number' ? stats.viewsCount : 0,
        'stats.sharesCount': typeof stats.sharesCount === 'number' ? stats.sharesCount : 0
      };

      // Count actual likes/reposts/comments from metadata if stats are missing
      if (updates['stats.likesCount'] === 0 && post.metadata?.likedBy && Array.isArray(post.metadata.likedBy)) {
        updates['stats.likesCount'] = post.metadata.likedBy.length;
      }
      // Reposts and comments could be counted from database, but for now just ensure they're at least 0
      if (typeof stats.repostsCount !== 'number') {
        updates['stats.repostsCount'] = 0;
      }
      if (typeof stats.commentsCount !== 'number') {
        updates['stats.commentsCount'] = 0;
      }

      await Post.findByIdAndUpdate(post._id, { $set: updates });
      fixed++;
      
      if (fixed % 100 === 0) {
        console.log(`✅ Fixed ${fixed}/${posts.length} posts...`);
      }
    }

    console.log(`✅ Fixed stats for ${fixed} posts`);

    // Also ensure all posts have visibility set
    const postsWithoutVisibility = await Post.find({
      visibility: { $exists: false }
    });
    
    if (postsWithoutVisibility.length > 0) {
      console.log(`📊 Found ${postsWithoutVisibility.length} posts without visibility`);
      await Post.updateMany(
        { visibility: { $exists: false } },
        { $set: { visibility: 'public' } }
      );
      console.log(`✅ Set visibility for ${postsWithoutVisibility.length} posts`);
    }

    await mongoose.disconnect();
    console.log('✅ Migration complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  fixPostStats();
}

export default fixPostStats;

