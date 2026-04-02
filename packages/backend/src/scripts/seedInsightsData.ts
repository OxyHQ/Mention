/**
 * Seed script to populate fake posts with realistic stats for testing the Insights screen.
 *
 * Usage:
 *   cd packages/backend && bun src/scripts/seedInsightsData.ts [oxyUserId]
 *
 * If no oxyUserId is provided, it will use the first user found in existing posts,
 * or fall back to a default ID.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention-development';

const FAKE_TEXTS = [
  'Just shipped a major update to our platform. Feeling good about the direction we are heading.',
  'Hot take: most productivity advice is just procrastination with extra steps.',
  'Been thinking a lot about how we build communities online. The best ones feel like neighborhoods, not stadiums.',
  'The secret to good software is deleting code, not writing it.',
  'Morning coffee and a blank editor. Best feeling in the world.',
  'What is everyone reading this week? I just finished a great book on distributed systems.',
  'Unpopular opinion: meetings can actually be useful if you keep them under 15 minutes.',
  'Just saw the most beautiful sunset from my office window. Sometimes you need to look up from the screen.',
  'Working on something new that I can not wait to share. Stay tuned.',
  'The best feature requests come from watching people use your product, not from surveys.',
  'TIL that the first computer bug was an actual bug — a moth stuck in a relay at Harvard in 1947.',
  'Shipped three PRs before lunch. Today is going to be a good day.',
  'Design tip: if you have to explain how something works, it does not work well enough yet.',
  'Grateful for this community. Your feedback has shaped so much of what we have built.',
  'Late night coding session. The quiet hours are when the best ideas happen.',
  'Just deployed to production with zero downtime. Infrastructure team deserves a raise.',
  'Reminder: your side project does not need to be a startup. It is okay to build things just for fun.',
  'The gap between a good product and a great product is in the details nobody notices.',
  'Had an amazing conversation today about the future of social media. Decentralization is the way.',
  'Friday vibes: closing all tabs, clearing the inbox, and starting fresh next week.',
  'Just hit 1000 commits on this project. What a journey it has been.',
  'Best debugging technique: explain the problem to someone else. Works every time.',
  'Building in public is scary but the feedback loop is incredible.',
  'New blog post dropping tomorrow about our architecture decisions. Lots of lessons learned.',
  'The internet is at its best when people share what they know freely.',
  'Spent the morning refactoring and it felt like cleaning a messy room. So satisfying.',
  'Pro tip: write your commit messages like someone will read them at 3am during an incident.',
  'Just wrapped up a great brainstorming session. The whiteboard is full and I am energized.',
  'Sometimes the best thing you can do for your code is take a walk.',
  'Celebrating small wins today. Every step forward counts.',
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysAgo: number): Date {
  const now = new Date();
  const msAgo = rand(0, daysAgo * 24 * 60 * 60 * 1000);
  return new Date(now.getTime() - msAgo);
}

async function seedInsightsData() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    // Determine user ID
    let userId = process.argv[2];
    if (!userId) {
      const existingPost = await Post.findOne({ oxyUserId: { $exists: true, $ne: null } })
        .sort({ createdAt: -1 })
        .lean();
      if (existingPost?.oxyUserId) {
        userId = existingPost.oxyUserId;
        console.log(`Using existing user: ${userId}`);
      } else {
        userId = 'seed-user-001';
        console.log(`No existing users found, using default: ${userId}`);
      }
    } else {
      console.log(`Using provided user: ${userId}`);
    }

    // Clean up previous seed data for this user
    const deleted = await Post.deleteMany({ oxyUserId: userId });
    console.log(`Cleaned up ${deleted.deletedCount} existing posts for user ${userId}`);

    // Create 30 posts spread across the last 90 days with varied stats
    const posts = [];
    for (let i = 0; i < 30; i++) {
      const createdAt = randomDate(90);
      const isHighPerformer = i < 5; // First 5 are top performers
      const viewsBase = isHighPerformer ? rand(500, 5000) : rand(20, 800);
      const likesBase = isHighPerformer ? rand(30, 300) : rand(1, 50);
      const repliesBase = isHighPerformer ? rand(10, 80) : rand(0, 15);
      const repostsBase = isHighPerformer ? rand(5, 50) : rand(0, 10);
      const sharesBase = rand(0, 8);

      const types = ['text', 'text', 'text', 'image', 'image', 'video', 'poll'] as const;
      const type = types[rand(0, types.length - 1)];

      posts.push({
        oxyUserId: userId,
        type,
        content: {
          text: FAKE_TEXTS[i % FAKE_TEXTS.length],
        },
        visibility: 'public',
        isEdited: false,
        status: 'published',
        stats: {
          viewsCount: viewsBase,
          likesCount: likesBase,
          repostsCount: repostsBase,
          commentsCount: repliesBase,
          sharesCount: sharesBase,
          downvotesCount: 0,
        },
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      });
    }

    const result = await Post.insertMany(posts);
    console.log(`Created ${result.length} fake posts for user ${userId}`);

    // Print summary
    const totalViews = posts.reduce((s, p) => s + p.stats.viewsCount, 0);
    const totalLikes = posts.reduce((s, p) => s + p.stats.likesCount, 0);
    const totalReplies = posts.reduce((s, p) => s + p.stats.commentsCount, 0);
    const totalReposts = posts.reduce((s, p) => s + p.stats.repostsCount, 0);
    console.log(`\nStats summary:`);
    console.log(`  Views: ${totalViews}`);
    console.log(`  Likes: ${totalLikes}`);
    console.log(`  Replies: ${totalReplies}`);
    console.log(`  Reposts: ${totalReposts}`);
    const typeCounts = posts.reduce((acc, p) => { acc[p.type] = (acc[p.type] || 0) + 1; return acc; }, {} as Record<string, number>);
    console.log(`  Post types: ${JSON.stringify(typeCounts)}`);

    // Print date range
    const dates = posts.map(p => p.createdAt).sort((a, b) => a.getTime() - b.getTime());
    console.log(`  Date range: ${dates[0].toISOString().split('T')[0]} to ${dates[dates.length - 1].toISOString().split('T')[0]}`);

    await mongoose.disconnect();
    console.log('\nDone! Seed data created successfully.');
  } catch (error) {
    console.error('Seed failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

seedInsightsData();
