/**
 * Migration: Spaces → Rooms
 *
 * Renames the "spaces" collection to "rooms" and adds the new taxonomy fields
 * (type, ownerType, broadcastKind) with safe defaults for existing documents.
 *
 * Run: npx ts-node src/migrations/001-spaces-to-rooms.ts
 *
 * This migration is idempotent — safe to re-run.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const APP_NAME = 'mention';

function getDatabaseName(): string {
  const env = process.env.NODE_ENV || 'development';
  return `${APP_NAME}-${env}`;
}

async function migrate() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI environment variable is not defined');
    process.exit(1);
  }

  const dbName = getDatabaseName();
  console.log(`Connecting to database: ${dbName}`);

  await mongoose.connect(mongoUri, { dbName });
  const db = mongoose.connection.db;

  if (!db) {
    console.error('Failed to get database reference');
    process.exit(1);
  }

  // Step 1: Check if "spaces" collection exists
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  const hasSpaces = collectionNames.includes('spaces');
  const hasRooms = collectionNames.includes('rooms');

  if (!hasSpaces && hasRooms) {
    console.log('Migration already complete: "rooms" collection exists, "spaces" does not.');
    console.log('Ensuring new fields have defaults...');
    await ensureNewFields(db);
    await mongoose.disconnect();
    return;
  }

  if (!hasSpaces && !hasRooms) {
    console.log('No "spaces" collection found. Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  // Step 2: Rename "spaces" → "rooms"
  if (hasSpaces && !hasRooms) {
    console.log('Renaming "spaces" collection to "rooms"...');
    await db.renameCollection('spaces', 'rooms');
    console.log('Collection renamed successfully.');
  } else if (hasSpaces && hasRooms) {
    // Both exist — merge spaces into rooms
    console.log('Both "spaces" and "rooms" exist. Merging spaces into rooms...');
    const spacesCollection = db.collection('spaces');
    const roomsCollection = db.collection('rooms');
    const spaceDocs = await spacesCollection.find({}).toArray();

    if (spaceDocs.length > 0) {
      // Check for duplicates by _id
      const existingIds = new Set(
        (await roomsCollection.find({}, { projection: { _id: 1 } }).toArray())
          .map(d => d._id.toString())
      );

      const newDocs = spaceDocs.filter(d => !existingIds.has(d._id.toString()));
      if (newDocs.length > 0) {
        await roomsCollection.insertMany(newDocs);
        console.log(`Merged ${newDocs.length} documents from spaces to rooms.`);
      } else {
        console.log('No new documents to merge.');
      }
    }
  }

  // Step 3: Add new fields with defaults
  await ensureNewFields(db);

  // Step 4: Create new indexes
  console.log('Creating new indexes...');
  const roomsCollection = db.collection('rooms');
  await roomsCollection.createIndex({ type: 1, status: 1 });
  await roomsCollection.createIndex({ houseId: 1, status: 1 });
  await roomsCollection.createIndex({ ownerType: 1, type: 1, status: 1 });
  await roomsCollection.createIndex({ seriesId: 1, scheduledStart: -1 });
  console.log('Indexes created.');

  // Step 5: Update Post attachments (space → room reference)
  console.log('Updating post attachments...');
  const postsCollection = db.collection('posts');
  const updateResult = await postsCollection.updateMany(
    { 'attachments.space': { $exists: true } },
    {
      $rename: { 'attachments.space.spaceId': 'attachments.space.roomId' },
    }
  );
  console.log(`Updated ${updateResult.modifiedCount} post attachments.`);

  console.log('Migration complete!');
  await mongoose.disconnect();
}

async function ensureNewFields(db: mongoose.mongo.Db) {
  console.log('Ensuring new fields have defaults...');
  const roomsCollection = db.collection('rooms');

  // Set ownerType = 'profile' for all docs without it
  const ownerResult = await roomsCollection.updateMany(
    { ownerType: { $exists: false } },
    { $set: { ownerType: 'profile' } }
  );
  console.log(`Set ownerType on ${ownerResult.modifiedCount} documents.`);

  // Set type = 'talk' for all docs without it
  const typeResult = await roomsCollection.updateMany(
    { type: { $exists: false } },
    { $set: { type: 'talk' } }
  );
  console.log(`Set type on ${typeResult.modifiedCount} documents.`);

  // Set broadcastKind = null for non-broadcast docs
  const bkResult = await roomsCollection.updateMany(
    { broadcastKind: { $exists: false } },
    { $set: { broadcastKind: null } }
  );
  console.log(`Set broadcastKind on ${bkResult.modifiedCount} documents.`);

  // Set houseId = null where missing
  const houseResult = await roomsCollection.updateMany(
    { houseId: { $exists: false } },
    { $set: { houseId: null } }
  );
  console.log(`Set houseId on ${houseResult.modifiedCount} documents.`);

  // Set seriesId = null where missing
  const seriesResult = await roomsCollection.updateMany(
    { seriesId: { $exists: false } },
    { $set: { seriesId: null } }
  );
  console.log(`Set seriesId on ${seriesResult.modifiedCount} documents.`);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
