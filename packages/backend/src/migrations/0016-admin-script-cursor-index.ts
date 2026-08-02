/**
 * Migration 0016: the UNIQUE identity of an administrative sweep's resume cursor.
 *
 * `AdminScriptCursor` stores where a long-running sweep got to, so a one-shot
 * Fargate task that is killed mid-run can be resumed instead of restarting at
 * the beginning and re-fetching everything it already visited. Its whole
 * usefulness rests on `(script, scope)` addressing exactly ONE row.
 *
 *  - `adminscriptcursors` UNIQUE `{ script: 1, scope: 1 }` — the cursor's
 *    identity. The sweep records progress with an upsert on that pair; WITHOUT
 *    the constraint, two tasks started against the same scope can each insert
 *    their own row, and the next run's `findOne` then resumes from whichever it
 *    happens to read. That is the invisible failure: a run that reports itself
 *    cleanly resumed while silently re-walking, or skipping, a stretch of the
 *    corpus. The schema declares the index, but `autoIndex`/`autoCreate` are OFF
 *    in production (see `utils/database.ts`), so this migration is the only
 *    thing that creates it.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, and it creates
 * the `adminscriptcursors` collection on first run. Data-free — the collection
 * is new, so the unique constraint has nothing to conflict with.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_ADMIN_SCRIPT_CURSOR_INDEX } from './constants';
import { AdminScriptCursor } from '../models/AdminScriptCursor';
import type { Migration } from './runner';

export const migrationAdminScriptCursorIndex: Migration = {
  id: MIGRATION_ADMIN_SCRIPT_CURSOR_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const cursors = db.collection(AdminScriptCursor.collection.collectionName);
    await cursors.createIndex({ script: 1, scope: 1 }, { unique: true });
    logger.info(
      `[migration] ensured index on ${cursors.collectionName} ` +
        `{ script: 1, scope: 1 } (unique)`,
    );
  },
};
