// Script to seed the database with fake posts for development
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Post from '../models/Post';
import Hashtag from '../models/Hashtag';

dotenv.config({ path: '../../.env' });

const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://oxy:bPLN8hbGDTCpoZa7@cluster0oxy.lh5pg.mongodb.net/myFirstDatabase?retryWrites=true&w=majority";

async function main() {
  if (!MONGO_URI) {
    console.error('No MongoDB URI found in environment variables.');
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI);

  // Upsert hashtags and get their ObjectIds
  const hashtagNames = ['seed', 'test'];
  const hashtagDocs = await Promise.all(
    hashtagNames.map(async (name) => {
      return await Hashtag.findOneAndUpdate(
        { name },
        { $setOnInsert: { name } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    })
  );
  const hashtagIds = hashtagDocs.map((doc) => doc._id);

  // Create fake posts
  const posts = Array.from({ length: 20 }).map((_, i) => ({
    text: `This is a seeded post #${i + 1}`,
    userID: '64f1e4b2c8d3f4a0b8e4b2c8',
    media: [],
    hashtags: hashtagIds,
    in_reply_to_status_id: null,
    quoted_post_id: null,
    source: 'seed',
    lang: 'en',
    isDraft: false,
    scheduledFor: null,
    status: 'published',
    created_at: new Date(),
    updated_at: new Date(),
  }));

  await Post.insertMany(posts);
  console.log('Seeded 20 posts.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
