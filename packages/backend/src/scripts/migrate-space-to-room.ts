/**
 * One-shot data migration: consolidate the deprecated `content.space` field onto
 * the canonical `content.room`.
 *
 * Historically a "Room" post was stored under `content.space` (with a `spaceId`
 * sub-field) and its attachment descriptor used `type: 'space'`. Both were the
 * old name for what is now `content.room` (`roomId`) / `type: 'room'`. The schema
 * removal (Post model + shared-types) drops `space` entirely, so this script
 * rewrites every legacy document onto `room` BEFORE the off-schema field becomes
 * unreadable through the model.
 *
 * For every Post where `content.space` exists, it:
 *   1. sets `content.room` from `content.space` (mapping `spaceId` → `roomId`)
 *      ONLY when `content.room` is absent — an existing `room` is never
 *      overwritten;
 *   2. rewrites any `content.attachments[].type === 'space'` → `'room'`,
 *      collapsing a duplicate `room` descriptor the rewrite would create;
 *   3. `$unset`s `content.space`.
 *
 * Because `content.space` is no longer in the Mongoose schema, the script reads
 * and writes through the RAW driver collection (`db.collection('posts')`) so
 * schema casting/stripping never hides the legacy field.
 *
 * It is idempotent and re-runnable (after a clean run nothing matches
 * `content.space: { $exists: true }`), pages by a stable ascending `_id` cursor,
 * flushes in bounded `bulkWrite` chunks, and prints a scanned/updated summary.
 *
 * Supports `DRY_RUN=1` (or `true`/`yes`) to report what WOULD change without
 * mutating anything.
 *
 * Runnable as a Fargate one-shot, BEFORE the schema-removal deploy is the safe
 * window but it is also safe to run after (it only touches legacy `content.space`
 * documents):
 *   DRY_RUN=1 node dist/scripts/migrate-space-to-room.js   # preview
 *   node dist/scripts/migrate-space-to-room.js             # migrate
 */

import mongoose from 'mongoose';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Updates flushed per `bulkWrite` chunk. */
const WRITE_CHUNK_SIZE = 500;

const DRY_RUN = ['1', 'true', 'yes'].includes((process.env.DRY_RUN || '').trim().toLowerCase());

/** The legacy `content.space` sub-document shape (old "Room" storage). */
interface LegacySpace {
  spaceId?: string;
  roomId?: string;
  title?: string;
  status?: string;
  topic?: string;
  host?: string;
}

/** The canonical `content.room` sub-document shape. */
interface RoomContent {
  roomId?: string;
  title?: string;
  status?: string;
  topic?: string;
  host?: string;
}

interface AttachmentDescriptor {
  type?: string;
  id?: string;
  mediaType?: string;
}

interface LegacyPostRow {
  _id: mongoose.Types.ObjectId;
  content?: {
    space?: LegacySpace;
    room?: RoomContent;
    attachments?: AttachmentDescriptor[];
  };
}

/**
 * Map a legacy `space` sub-document onto a canonical `room` one (`spaceId` →
 * `roomId`), omitting keys that are absent so the stored `room` carries only
 * real values.
 */
function roomFromSpace(space: LegacySpace): RoomContent {
  const room: RoomContent = {};
  const roomId = space.roomId ?? space.spaceId;
  if (typeof roomId === 'string') room.roomId = roomId;
  if (typeof space.title === 'string') room.title = space.title;
  if (typeof space.status === 'string') room.status = space.status;
  if (typeof space.topic === 'string') room.topic = space.topic;
  if (typeof space.host === 'string') room.host = space.host;
  return room;
}

/**
 * Rewrite `space` attachment descriptors to `room`, dropping the duplicate
 * `room` descriptor the rewrite would create (non-media attachment types are
 * unique per post). Returns `null` when nothing changed.
 */
function migrateAttachments(attachments: AttachmentDescriptor[]): AttachmentDescriptor[] | null {
  let changed = false;
  const seenNonMedia = new Set<string>();
  const result: AttachmentDescriptor[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      result.push(attachment);
      continue;
    }

    let type = attachment.type;
    if (type === 'space') {
      type = 'room';
      changed = true;
    }

    if (type && type !== 'media') {
      if (seenNonMedia.has(type)) {
        // A duplicate non-media descriptor (e.g. both legacy `space` and a real
        // `room`) collapses to one — matches the read-side dedup.
        changed = true;
        continue;
      }
      seenNonMedia.add(type);
    }

    result.push(type === attachment.type ? attachment : { ...attachment, type });
  }

  return changed ? result : null;
}

async function migrateSpaceToRoom(): Promise<void> {
  const startedAt = Date.now();

  try {
    await connectToDatabase();
    logger.info(
      `[migrate-space-to-room] connected to MongoDB${DRY_RUN ? ' — DRY_RUN (no writes)' : ''}`,
    );

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('MongoDB connection has no database handle after connect');
    }
    const collection = db.collection('posts');

    let scanned = 0;
    let roomCopied = 0;
    let attachmentsRewritten = 0;
    let updated = 0;
    let lastId: mongoose.Types.ObjectId | null = null;
    let pendingOps: mongoose.mongo.AnyBulkWriteOperation[] = [];

    const flush = async (): Promise<void> => {
      if (pendingOps.length === 0) return;
      if (!DRY_RUN) {
        const result = await collection.bulkWrite(pendingOps, { ordered: false });
        updated += result.modifiedCount ?? 0;
      }
      pendingOps = [];
    };

    for (;;) {
      const pageFilter: Record<string, unknown> = { 'content.space': { $exists: true } };
      if (lastId) pageFilter._id = { $gt: lastId };

      const page = await collection
        .find<LegacyPostRow>(pageFilter, {
          projection: { _id: 1, 'content.space': 1, 'content.room': 1, 'content.attachments': 1 },
          sort: { _id: 1 },
          limit: PAGE_SIZE,
        })
        .toArray();

      if (page.length === 0) break;

      for (const row of page) {
        const space = row.content?.space;
        if (!space) continue; // defensive: projection guarantees presence

        const setOps: Record<string, unknown> = {};

        // 1. Copy room data only when there is no canonical room yet.
        if (!row.content?.room) {
          const room = roomFromSpace(space);
          if (room.roomId) {
            setOps['content.room'] = room;
            roomCopied += 1;
          }
        }

        // 2. Rewrite `space` attachment descriptors to `room`.
        if (Array.isArray(row.content?.attachments)) {
          const rewritten = migrateAttachments(row.content.attachments);
          if (rewritten) {
            setOps['content.attachments'] = rewritten;
            attachmentsRewritten += 1;
          }
        }

        // 3. Always drop the deprecated field.
        const update: Record<string, unknown> = { $unset: { 'content.space': '' } };
        if (Object.keys(setOps).length > 0) update.$set = setOps;

        pendingOps.push({ updateOne: { filter: { _id: row._id }, update } });
        if (pendingOps.length >= WRITE_CHUNK_SIZE) {
          await flush();
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
    }

    await flush();

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[migrate-space-to-room] done${DRY_RUN ? ' (DRY_RUN)' : ''}: scanned ${scanned}, roomCopied ${roomCopied}, attachmentsRewritten ${attachmentsRewritten}, updated ${DRY_RUN ? 0 : updated} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[migrate-space-to-room] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  migrateSpaceToRoom();
}

export default migrateSpaceToRoom;
