/**
 * Seed script to populate the Topic collection from existing data sources.
 *
 * 1. Upserts the 24 hardcoded interests as category-type topics.
 * 2. Aggregates unique extracted topic names from Posts and creates topic/entity documents.
 *
 * Idempotent — safe to re-run. Uses bulkWrite with upsert keyed on name.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/seedTopics.ts
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import Topic, { TopicType, TopicSource } from '../models/Topic';

const SEED_INTERESTS: Array<{ name: string; displayName: string }> = [
  { name: 'animals', displayName: 'Animals' },
  { name: 'art', displayName: 'Art' },
  { name: 'books', displayName: 'Books' },
  { name: 'comedy', displayName: 'Comedy' },
  { name: 'comics', displayName: 'Comics' },
  { name: 'culture', displayName: 'Culture' },
  { name: 'dev', displayName: 'Software Dev' },
  { name: 'education', displayName: 'Education' },
  { name: 'finance', displayName: 'Finance' },
  { name: 'food', displayName: 'Food' },
  { name: 'gaming', displayName: 'Video Games' },
  { name: 'journalism', displayName: 'Journalism' },
  { name: 'movies', displayName: 'Movies' },
  { name: 'music', displayName: 'Music' },
  { name: 'nature', displayName: 'Nature' },
  { name: 'news', displayName: 'News' },
  { name: 'pets', displayName: 'Pets' },
  { name: 'photography', displayName: 'Photography' },
  { name: 'politics', displayName: 'Politics' },
  { name: 'science', displayName: 'Science' },
  { name: 'sports', displayName: 'Sports' },
  { name: 'tech', displayName: 'Tech' },
  { name: 'tv', displayName: 'TV' },
  { name: 'writers', displayName: 'Writers' },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function seedTopics() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
  await mongoose.connect(mongoUri, { dbName });
  console.log(`Connected to MongoDB (${dbName})`);

  // Step 1: Seed hardcoded interests as categories
  console.log('Seeding category topics from hardcoded interests...');

  const categoryOps = SEED_INTERESTS.map(({ name, displayName }) => ({
    updateOne: {
      filter: { name },
      update: {
        $setOnInsert: {
          name,
          slug: slugify(name),
          displayName,
          description: '',
          type: TopicType.CATEGORY,
          source: TopicSource.SEED,
          aliases: [],
          popularity: 0,
          postCount: 0,
          isActive: true,
        },
      },
      upsert: true,
    },
  }));

  const categoryResult = await Topic.bulkWrite(categoryOps, { ordered: false });
  console.log(`Categories: ${categoryResult.upsertedCount} created, ${categoryResult.modifiedCount} updated`);

  // Step 2: Aggregate extracted topics from posts
  console.log('Aggregating extracted topics from posts...');

  const extractedTopics = await Post.aggregate([
    { $match: { 'extracted.topics': { $exists: true, $ne: [] } } },
    { $unwind: '$extracted.topics' },
    {
      $group: {
        _id: '$extracted.topics.name',
        type: { $first: '$extracted.topics.type' },
        count: { $sum: 1 },
        totalRelevance: { $sum: '$extracted.topics.relevance' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  console.log(`Found ${extractedTopics.length} unique extracted topics`);

  // Filter out names that already exist as categories
  const categoryNames = new Set(SEED_INTERESTS.map(i => i.name));
  const newTopics = extractedTopics.filter(
    (t: { _id: string }) => !categoryNames.has(t._id),
  );

  if (newTopics.length > 0) {
    const topicOps = newTopics.map((t: { _id: string; type: string; count: number; totalRelevance: number }) => {
      const name = t._id.toLowerCase().trim();
      const topicType = t.type === 'entity' ? TopicType.ENTITY : TopicType.TOPIC;

      return {
        updateOne: {
          filter: { name },
          update: {
            $setOnInsert: {
              name,
              slug: slugify(name),
              displayName: t._id, // preserve original casing from first occurrence
              description: '',
              type: topicType,
              source: TopicSource.AI,
              aliases: [],
              popularity: 0,
              isActive: true,
            },
            $set: {
              postCount: t.count,
            },
          },
          upsert: true,
        },
      };
    });

    const topicResult = await Topic.bulkWrite(topicOps, { ordered: false });
    console.log(`Extracted topics: ${topicResult.upsertedCount} created, ${topicResult.modifiedCount} updated`);
  }

  const totalTopics = await Topic.countDocuments();
  console.log(`\nDone. Total topics in collection: ${totalTopics}`);

  await mongoose.disconnect();
}

seedTopics().catch(error => {
  console.error('Seed script failed:', error);
  process.exit(1);
});
