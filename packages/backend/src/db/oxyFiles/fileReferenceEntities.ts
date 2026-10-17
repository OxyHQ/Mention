/**
 * The kinds of Mention entity that use an Oxy file — the ONE definition of
 * "entity E uses file F" (ADR 0043 D4/D6, `docs/oxy-files.md`).
 *
 * Three consumers read it, and they must agree, which is why it is one table:
 *
 *  - the reference drain (`services/oxyFiles/fileReferenceSync.ts`) asks {@link FileReferenceEntity.pairsInUse}
 *    whether a pair the triggers marked is still in use, and tells Oxy;
 *  - the nightly reconciliation (`services/oxyFiles/fileReferenceReconciliation.ts`) sends
 *    {@link FileReferenceEntity.inventory} as the full truth for each Oxy
 *    entity type;
 *  - the federated-media deletion drain asks {@link filesInUseByFederatedMedia}
 *    whether Mention still shows a re-hosted file before deleting it.
 *
 * The triggers of migration 0077 are the fourth reader of the same facts (which
 * column holds the file id and which the entity id); a new entity type is a new
 * entry here, a new trigger, and a new value in `FILE_REFERENCE_ENTITY_TYPES`.
 *
 * ## Sharding
 *
 * Oxy reconciles at most 500,000 pairs per entity type per session ("split the
 * entity type"). Posts are past that, so `post` is sent to Oxy as 32 entity
 * types, `post.00` … `post.31`, by the first byte of the MD5 of the post id —
 * computed identically here and in SQL (`shardSql`), stable for the life of
 * the post. Each shard is reconciled on its own, and its whole inventory is
 * read in one statement (a shard is bounded by Oxy's cap, so it fits).
 */

import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../postgres';
import type { FILE_REFERENCE_ENTITY_TYPES } from '../schema/oxyFiles';

export type FileReferenceEntityType = (typeof FILE_REFERENCE_ENTITY_TYPES)[number];

/** One use: the file and the entity of a known type that uses it. */
export interface FileReferencePair {
  fileId: string;
  entityId: string;
}

export interface FileReferenceEntity {
  readonly type: FileReferenceEntityType;
  /** How many Oxy entity types it is sent as (1: just `type`). */
  readonly shards: number;
  /** What a reader of `docs/oxy-files.md` sees: the table and columns. */
  readonly source: string;
  /** The subset of `pairs` in use now, as {@link pairKey}s. */
  pairsInUse(db: DatabaseOrTransaction, pairs: readonly FileReferencePair[]): Promise<Set<string>>;
  /** Every pair in use whose entity falls in `shard` (0 when unsharded). */
  inventory(db: DatabaseOrTransaction, shard: number): Promise<FileReferencePair[]>;
  /** Of `fileIds`, the ones some entity of this type uses now. */
  filesInUse(db: DatabaseOrTransaction, fileIds: readonly string[]): Promise<Set<string>>;
}

/** The map key of a pair. NUL cannot occur in either id. */
export function pairKey(fileId: string, entityId: string): string {
  return `${fileId}\u0000${entityId}`;
}

/** Oxy's per-session reconciliation ceiling (`MAX_RECONCILE_ITEMS`). */
export const OXY_RECONCILE_MAX_ITEMS = 500_000;

/** Shards of `post`. 32 divides 256, so every shard is an equal slice of the first MD5 byte. */
export const POST_REFERENCE_SHARDS = 32;

/** The shard of an entity id: the first byte of its MD5, modulo `shards`. */
export function shardOf(entityId: string, shards: number): number {
  if (shards <= 1) return 0;
  return createHash('md5').update(entityId, 'utf8').digest()[0] % shards;
}

/** {@link shardOf} in SQL, over a column or expression. */
export function shardSql(column: SQL, shards: number): SQL {
  return sql`(get_byte(decode(md5(${column}), 'hex'), 0) % ${sql.raw(String(shards))})`;
}

/**
 * "This text is an Oxy file id" in SQL: the rule of `isOxyFileId`
 * (`services/postMediaVisibility.ts`) and of `mention_mark_file_reference`.
 */
function isOxyFileIdSql(column: SQL): SQL {
  return sql`(btrim(${column}) <> '' and ${column} not like 'temp-%' and ${column} !~* '^https?://')`;
}

/** The Oxy entity type a pair of `type` is registered under. */
export function oxyEntityTypeFor(entity: FileReferenceEntity, entityId: string): string {
  return oxyEntityTypeName(entity, shardOf(entityId, entity.shards));
}

/** The Oxy entity type of one shard. */
export function oxyEntityTypeName(entity: FileReferenceEntity, shard: number): string {
  return entity.shards <= 1 ? entity.type : `${entity.type}.${String(shard).padStart(2, '0')}`;
}

/** Reads an Oxy entity type back (a file event names its references by it), or null. */
export function parseOxyEntityType(
  oxyEntityType: string,
): { entity: FileReferenceEntity; shard: number } | null {
  const [base, shardText, extra] = oxyEntityType.split('.');
  const entity = FILE_REFERENCE_ENTITIES.find((candidate) => candidate.type === base);
  if (!entity || extra !== undefined) return null;
  if (entity.shards <= 1) return shardText === undefined ? { entity, shard: 0 } : null;
  if (shardText === undefined || !/^\d{2}$/.test(shardText)) return null;
  const shard = Number(shardText);
  return shard < entity.shards ? { entity, shard } : null;
}

/** The `(file, entity)` pairs as two parallel arrays, for `unnest`. */
function unnestPairs(pairs: readonly FileReferencePair[]): SQL {
  return sql`unnest(${sql.param(pairs.map((pair) => pair.fileId))}::text[], ${sql.param(
    pairs.map((pair) => pair.entityId),
  )}::text[]) as t(file_id, entity_id)`;
}

async function rowsOf<T extends Record<string, unknown>>(
  db: DatabaseOrTransaction,
  query: SQL,
): Promise<T[]> {
  return [...(await db.execute<T>(query))] as T[];
}

async function pairSet(db: DatabaseOrTransaction, query: SQL): Promise<Set<string>> {
  const rows = await rowsOf<{ file_id: string; entity_id: string }>(db, query);
  return new Set(rows.map((row) => pairKey(row.file_id, row.entity_id)));
}

async function idSet(db: DatabaseOrTransaction, query: SQL): Promise<Set<string>> {
  const rows = await rowsOf<{ id: string }>(db, query);
  return new Set(rows.map((row) => row.id));
}

async function pairList(db: DatabaseOrTransaction, query: SQL): Promise<FileReferencePair[]> {
  const rows = await rowsOf<{ file_id: string; entity_id: string }>(db, query);
  return rows.map((row) => ({ fileId: row.file_id, entityId: row.entity_id }));
}

/** `post`: the post's shared media and every language variant's override. */
const postEntity: FileReferenceEntity = {
  type: 'post',
  shards: POST_REFERENCE_SHARDS,
  source: 'post_media.media_id, post_variant_media.media_id (entity: posts.id)',
  async pairsInUse(db, pairs) {
    if (pairs.length === 0) return new Set();
    return pairSet(
      db,
      sql`select t.file_id, t.entity_id from ${unnestPairs(pairs)}
        where exists (
          select 1 from post_media m where m.post_id = t.entity_id and m.media_id = t.file_id
        ) or exists (
          select 1 from post_variant_media vm
          join post_content_variants v on v.id = vm.variant_id
          where v.post_id = t.entity_id and vm.media_id = t.file_id
        )`,
    );
  },
  async inventory(db, shard) {
    return pairList(
      db,
      sql`select m.media_id as file_id, m.post_id as entity_id from post_media m
          where ${shardSql(sql`m.post_id`, POST_REFERENCE_SHARDS)} = ${shard}
            and ${isOxyFileIdSql(sql`m.media_id`)}
        union
        select vm.media_id, v.post_id from post_variant_media vm
          join post_content_variants v on v.id = vm.variant_id
          where ${shardSql(sql`v.post_id`, POST_REFERENCE_SHARDS)} = ${shard}
            and ${isOxyFileIdSql(sql`vm.media_id`)}`,
    );
  },
  async filesInUse(db, fileIds) {
    if (fileIds.length === 0) return new Set();
    const ids = sql.param([...fileIds]);
    return idSet(
      db,
      sql`select media_id as id from post_media where media_id = any(${ids}::text[])
        union
        select media_id from post_variant_media where media_id = any(${ids}::text[])`,
    );
  },
};

/** `gif`: a GIF library row's full mp4 and its picker preview. */
const gifEntity: FileReferenceEntity = {
  type: 'gif',
  shards: 1,
  source: 'gifs.mp4_file_id, gifs.preview_file_id (entity: gifs.id)',
  async pairsInUse(db, pairs) {
    if (pairs.length === 0) return new Set();
    return pairSet(
      db,
      sql`select t.file_id, t.entity_id from ${unnestPairs(pairs)}
        where exists (
          select 1 from gifs g
          where g.id = t.entity_id and (g.mp4_file_id = t.file_id or g.preview_file_id = t.file_id)
        )`,
    );
  },
  async inventory(db) {
    return pairList(
      db,
      sql`select mp4_file_id as file_id, id as entity_id from gifs
        union
        select preview_file_id, id from gifs`,
    );
  },
  async filesInUse(db, fileIds) {
    if (fileIds.length === 0) return new Set();
    const ids = sql.param([...fileIds]);
    return idSet(
      db,
      sql`select mp4_file_id as id from gifs where mp4_file_id = any(${ids}::text[])
        union
        select preview_file_id from gifs where preview_file_id = any(${ids}::text[])`,
    );
  },
};

/** `profile_banner`: a local or federated account's banner, under its Oxy user id. */
const profileBannerEntity: FileReferenceEntity = {
  type: 'profile_banner',
  shards: 1,
  source: 'user_settings.profile_header_image (entity: user_settings.oxy_user_id)',
  async pairsInUse(db, pairs) {
    if (pairs.length === 0) return new Set();
    return pairSet(
      db,
      sql`select t.file_id, t.entity_id from ${unnestPairs(pairs)}
        where exists (
          select 1 from user_settings s
          where s.oxy_user_id = t.entity_id and s.profile_header_image = t.file_id
        )`,
    );
  },
  async inventory(db) {
    return pairList(
      db,
      sql`select profile_header_image as file_id, oxy_user_id as entity_id from user_settings
        where profile_header_image is not null
          and ${isOxyFileIdSql(sql`profile_header_image`)}`,
    );
  },
  async filesInUse(db, fileIds) {
    if (fileIds.length === 0) return new Set();
    return idSet(
      db,
      sql`select profile_header_image as id from user_settings
        where profile_header_image = any(${sql.param([...fileIds])}::text[])`,
    );
  },
};

/**
 * `video_poster`: the poster frame Oxy-hosted for a re-hosted federated video,
 * under the VIDEO's file id — in use while that video is (a post or a variant
 * shows it). The same rule the federated deletion drain has always applied.
 */
const videoPosterEntity: FileReferenceEntity = {
  type: 'video_poster',
  shards: 1,
  source:
    'federated_media_posters.poster_file_id (entity: federated_media_posters.video_file_id, while a post shows the video)',
  async pairsInUse(db, pairs) {
    if (pairs.length === 0) return new Set();
    return pairSet(
      db,
      sql`select t.file_id, t.entity_id from ${unnestPairs(pairs)}
        where exists (
          select 1 from federated_media_posters p
          where p.video_file_id = t.entity_id and p.poster_file_id = t.file_id
        ) and (
          exists (select 1 from post_media m where m.media_id = t.entity_id)
          or exists (select 1 from post_variant_media vm where vm.media_id = t.entity_id)
        )`,
    );
  },
  async inventory(db) {
    return pairList(
      db,
      sql`select p.poster_file_id as file_id, p.video_file_id as entity_id
        from federated_media_posters p
        where exists (select 1 from post_media m where m.media_id = p.video_file_id)
           or exists (select 1 from post_variant_media vm where vm.media_id = p.video_file_id)`,
    );
  },
  async filesInUse(db, fileIds) {
    if (fileIds.length === 0) return new Set();
    return idSet(
      db,
      sql`select p.poster_file_id as id from federated_media_posters p
        where p.poster_file_id = any(${sql.param([...fileIds])}::text[])
          and (
            exists (select 1 from post_media m where m.media_id = p.video_file_id)
            or exists (select 1 from post_variant_media vm where vm.media_id = p.video_file_id)
          )`,
    );
  },
};

/** `job_application`: the resume attached to a job application. */
const jobApplicationEntity: FileReferenceEntity = {
  type: 'job_application',
  shards: 1,
  source: 'mention_job_applications.resume_file_id (entity: mention_job_applications.id)',
  async pairsInUse(db, pairs) {
    if (pairs.length === 0) return new Set();
    return pairSet(
      db,
      sql`select t.file_id, t.entity_id from ${unnestPairs(pairs)}
        where exists (
          select 1 from mention_job_applications a
          where a.id = t.entity_id and a.resume_file_id = t.file_id
        )`,
    );
  },
  async inventory(db) {
    return pairList(
      db,
      sql`select resume_file_id as file_id, id as entity_id from mention_job_applications
        where resume_file_id is not null and ${isOxyFileIdSql(sql`resume_file_id`)}`,
    );
  },
  async filesInUse(db, fileIds) {
    if (fileIds.length === 0) return new Set();
    return idSet(
      db,
      sql`select resume_file_id as id from mention_job_applications
        where resume_file_id = any(${sql.param([...fileIds])}::text[])`,
    );
  },
};

/**
 * `moderation_report`: the application-owned copies of a reported post's media
 * a report sent CrowdSource as evidence, while the report exists.
 */
const moderationReportEntity: FileReferenceEntity = {
  type: 'moderation_report',
  shards: 1,
  source: 'moderation_report_evidence_files.evidence_file_id (entity: reports.id)',
  async pairsInUse(db, pairs) {
    if (pairs.length === 0) return new Set();
    return pairSet(
      db,
      sql`select t.file_id, t.entity_id from ${unnestPairs(pairs)}
        where exists (
          select 1 from moderation_report_evidence_files e
          where e.report_id = t.entity_id and e.evidence_file_id = t.file_id
        )`,
    );
  },
  async inventory(db) {
    return pairList(
      db,
      sql`select distinct evidence_file_id as file_id, report_id as entity_id
        from moderation_report_evidence_files
        where evidence_file_id is not null`,
    );
  },
  async filesInUse(db, fileIds) {
    if (fileIds.length === 0) return new Set();
    return idSet(
      db,
      sql`select evidence_file_id as id from moderation_report_evidence_files
        where evidence_file_id = any(${sql.param([...fileIds])}::text[])`,
    );
  },
};

/** Every entity type, in `FILE_REFERENCE_ENTITY_TYPES` order. */
export const FILE_REFERENCE_ENTITIES: readonly FileReferenceEntity[] = [
  postEntity,
  gifEntity,
  profileBannerEntity,
  videoPosterEntity,
  jobApplicationEntity,
  moderationReportEntity,
];

const BY_TYPE = new Map(FILE_REFERENCE_ENTITIES.map((entity) => [entity.type, entity]));

export function fileReferenceEntity(type: FileReferenceEntityType): FileReferenceEntity {
  const entity = BY_TYPE.get(type);
  if (!entity) throw new Error(`No file reference entity type "${type}"`);
  return entity;
}

/**
 * The entity types that can show a file Mention re-hosted from a federated
 * source (owned by the federated actor's Oxy account): a post, a federated
 * account's banner and a federated video's poster. GIF files are the
 * application's and resumes a local person's — rows are per owner in Oxy, so
 * no federated file id can appear there.
 */
const FEDERATED_MEDIA_ENTITY_TYPES: readonly FileReferenceEntityType[] = [
  'post',
  'profile_banner',
  'video_poster',
];

/**
 * Of `fileIds`, the re-hosted federated files Mention still shows — the
 * federated deletion drain's reference check, under its per-file locks.
 */
export async function filesInUseByFederatedMedia(
  db: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<Set<string>> {
  const used = new Set<string>();
  if (fileIds.length === 0) return used;
  for (const type of FEDERATED_MEDIA_ENTITY_TYPES) {
    for (const id of await fileReferenceEntity(type).filesInUse(db, fileIds)) used.add(id);
  }
  return used;
}
