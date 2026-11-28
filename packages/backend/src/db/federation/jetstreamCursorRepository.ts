/**
 * `jetstream_cursors`: the Bluesky Jetstream consumer's durable resume position,
 * one row per stream. See the table's docblock in `schema/federation.ts`.
 */

import { eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { jetstreamCursors } from '../schema/federation';

/** The stream's saved cursor, or null before its first save. */
export async function readJetstreamCursor(stream: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ cursor: jetstreamCursors.cursor })
    .from(jetstreamCursors)
    .where(eq(jetstreamCursors.id, stream))
    .limit(1);
  return row?.cursor ?? null;
}

/** Save the stream's cursor (insert the first time, overwrite after). */
export async function writeJetstreamCursor(stream: string, cursor: string): Promise<void> {
  await getDb()
    .insert(jetstreamCursors)
    .values({ id: stream, cursor })
    .onConflictDoUpdate({
      target: jetstreamCursors.id,
      set: { cursor, updatedAt: sql`now()` },
    });
}
