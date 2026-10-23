import type { MediaItem } from '@mention/shared-types';
import { sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import type { postMedia, postVariantMedia } from '../../db/schema/postContent';

export interface FileMediaMetadataWrite {
  rowId: string;
  postId: string;
  item: MediaItem;
}

/** A concurrent edit may replace a row or its file while Oxy is being read. */
export async function applyFileMediaMetadata(
  table: typeof postMedia | typeof postVariantMedia,
  writes: readonly FileMediaMetadataWrite[],
  connection: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (writes.length === 0) return new Set();
  const values = writes.map(
    ({ rowId, item }) => sql`(
      ${rowId}::text, ${item.id}::text,
      ${item.width ?? null}::integer, ${item.height ?? null}::integer,
      ${item.durationSec ?? null}::double precision,
      ${item.orientation ?? null}::text, ${item.aspectRatio ?? null}::double precision,
      ${item.sizeBytes ?? null}::integer, ${item.hlsReadyAt ?? null}::timestamptz
    )`,
  );
  const updated = await connection.execute<{ id: string }>(sql`
    update ${table} set
      width = v.width, height = v.height, duration_sec = v.duration_sec,
      orientation = v.orientation, aspect_ratio = v.aspect_ratio,
      size_bytes = v.size_bytes, hls_ready_at = v.hls_ready_at
    from (values ${sql.join(values, sql`, `)})
      as v(id, media_id, width, height, duration_sec, orientation, aspect_ratio, size_bytes, hls_ready_at)
    where ${table.id} = v.id and ${table.mediaId} = v.media_id and ${table.type} = 'video'
      and (${table.hlsReadyAt} is null or v.hls_ready_at >= ${table.hlsReadyAt})
      and (${table.width}, ${table.height}, ${table.durationSec}, ${table.orientation},
           ${table.aspectRatio}, ${table.sizeBytes}, ${table.hlsReadyAt})
        is distinct from
          (v.width, v.height, v.duration_sec, v.orientation, v.aspect_ratio, v.size_bytes, v.hls_ready_at)
    returning ${table.id}
  `);
  return new Set(updated.map((row) => row.id));
}
