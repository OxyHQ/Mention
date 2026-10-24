import type { MediaItem } from '@mention/shared-types';
import { sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../db/postgres';
import type { postMedia, postVariantMedia } from '../db/schema/postContent';

export interface FileMediaMetadataWrite {
  rowId: string;
  postId: string;
  item: MediaItem;
  previousHlsReadyAt: string | null;
  rejectedHlsReadyAt?: string;
}

/** A concurrent edit may replace a row or its file while Oxy is being read. */
export async function applyFileMediaMetadata(
  table: typeof postMedia | typeof postVariantMedia,
  writes: readonly FileMediaMetadataWrite[],
  connection: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (writes.length === 0) return new Set();
  const values = writes.map(
    ({ rowId, item, previousHlsReadyAt, rejectedHlsReadyAt }) => sql`(
      ${rowId}::text, ${item.id}::text, ${item.type}::text,
      ${previousHlsReadyAt}::timestamptz, ${rejectedHlsReadyAt ?? null}::timestamptz,
      ${item.width ?? null}::integer, ${item.height ?? null}::integer,
      ${item.durationSec ?? null}::double precision,
      ${item.orientation ?? null}::text, ${item.aspectRatio ?? null}::double precision,
      ${item.sizeBytes ?? null}::integer, ${item.hlsReadyAt ?? null}::timestamptz
    )`,
  );
  const updated = await connection.execute<{ id: string }>(sql`
    update ${table} set
      width = case when v.rejected_hls is null then v.width else ${table.width} end,
      height = case when v.rejected_hls is null then v.height else ${table.height} end,
      duration_sec = case when v.rejected_hls is null then v.duration_sec else ${table.durationSec} end,
      orientation = case when v.rejected_hls is null then v.orientation else ${table.orientation} end,
      aspect_ratio = case when v.rejected_hls is null then v.aspect_ratio else ${table.aspectRatio} end,
      size_bytes = case when v.rejected_hls is null then v.size_bytes else ${table.sizeBytes} end,
      hls_ready_at = case when v.rejected_hls is null then v.hls_ready_at else null end
    from (values ${sql.join(values, sql`, `)})
      as v(id, media_id, media_type, previous_hls, rejected_hls, width, height, duration_sec, orientation, aspect_ratio, size_bytes, hls_ready_at)
    where ${table.id} = v.id and ${table.mediaId} = v.media_id and ${table.type} = v.media_type
      and ${table.hlsReadyAt} is not distinct from v.previous_hls
      and (
        (v.rejected_hls is not null and ${table.type} = 'video' and ${table.hlsReadyAt} <= v.rejected_hls)
        or (v.rejected_hls is null and (${table.hlsReadyAt} is null or v.hls_ready_at >= ${table.hlsReadyAt}))
      )
      and (v.rejected_hls is not null or (${table.width}, ${table.height}, ${table.durationSec}, ${table.orientation},
           ${table.aspectRatio}, ${table.sizeBytes}, ${table.hlsReadyAt})
        is distinct from
          (v.width, v.height, v.duration_sec, v.orientation, v.aspect_ratio, v.size_bytes, v.hls_ready_at))
    returning ${table.id}
  `);
  return new Set(updated.map((row) => row.id));
}
