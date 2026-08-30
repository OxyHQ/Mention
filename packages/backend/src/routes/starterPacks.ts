import express, { Response } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { and, asc, desc, eq, ilike, inArray, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction, type Transaction } from '../db/postgres';
import {
  STARTER_PACK_MAX_MEMBERS,
  starterPackMembers,
  starterPackUses,
  starterPacks,
} from '../db/schema/lists';
import { resolveUserSummaries, isFallbackUserSummary } from '../services/PostHydrationService';
import { invalidate as invalidateUserSummaries } from '../services/userSummaryCache';
import type { PostUser } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { queryInt, queryString } from '../utils/queryParams';
import { endorsementSignalService } from '../services/EndorsementSignalService';

/**
 * What a starter pack's own two text fields may be.
 *
 * `name` was tested for TRUTHINESS and then written through `String(name)`, so
 * `{}` became the literal `"[object Object]"` — a 201 and a persisted row, with
 * nothing to tell anyone it had happened. The PUT branched on
 * `name === undefined`, so `name: null` wrote the four-character string
 * `"null"` over a real name.
 *
 * NO length cap is imposed: the columns are unbounded `text` and always have
 * been, and capping here would refuse rows that already exist.
 *
 * `memberOxyUserIds` stays `unknown` because `normalizeMemberIds` is already
 * total over any JSON value; it is named only because zod strips a key it was
 * not told about.
 */
const createStarterPackSchema = z.object({
  name: z.string('Name is required').min(1, 'Name is required'),
  description: z.string('description must be a string').nullish(),
  memberOxyUserIds: z.unknown().optional(),
});

/** The same fields, all optional: an absent one leaves the stored value alone. */
const updateStarterPackSchema = z.object({
  name: z.string('name must be a non-empty string').min(1, 'name must be a non-empty string').optional(),
  description: z.string('description must be a string').nullish(),
  memberOxyUserIds: z.unknown().optional(),
});

/**
 * Fire-and-forget endorsement re-sync for a starter pack whose membership
 * changed. Never blocks or fails the request — Oxy reputation signals are
 * eventually consistent (the outbox retries on failure).
 */
function syncPackEndorsements(packId: string): void {
  void endorsementSignalService
    .syncScope('starterPack', packId)
    .catch((error) => logger.warn('[StarterPacks] endorsement sync failed', error));
}

/**
 * Evict the cached author summaries of every member whose starter-pack CURATION
 * score just changed, so the `starterPackBoost` ranking signal picks the new value
 * up on the next hydration instead of waiting out the 10-minute TTL.
 *
 * The score is a function of (pack membership × pack `useCount` × curator), so it
 * changes for the members of ANY pack that is created, edited, deleted, or used.
 * Pass BOTH the previous and the next member sets: a removed member's score has to
 * be recomputed just as much as an added one's.
 *
 * Fire-and-forget and fail-soft — a cache eviction must never fail a write, and a
 * miss only means the score is stale for at most one TTL.
 */
function invalidateCurationScores(...memberIdGroups: Array<string[] | undefined>): void {
  const memberIds = new Set<string>();
  for (const group of memberIdGroups) {
    for (const id of group ?? []) {
      if (typeof id === 'string' && id.length > 0) memberIds.add(id);
    }
  }
  if (memberIds.size === 0) return;

  void invalidateUserSummaries(Array.from(memberIds)).catch((error) =>
    logger.warn('[StarterPacks] curation cache invalidation failed', {
      memberCount: memberIds.size,
      reason: error instanceof Error ? error.message : 'unknown',
    }),
  );
}

function syncPackMembershipChange(
  packId: string,
  ownerId: string,
  previousMemberIds: string[],
  nextMemberIds: string[],
): void {
  void endorsementSignalService
    .syncScopeMembershipChange('starterPack', packId, ownerId, previousMemberIds, nextMemberIds)
    .catch((error) => logger.warn('[StarterPacks] endorsement membership sync failed', error));
}

const router = express.Router();

/**
 * Page size for the paginated starter-pack listing. The default is the window
 * this route already returned before it paginated, so the callers that pass no
 * `limit` (explore, the profile tab, the "add to pack" sheet, the feed
 * interstitial) see exactly what they saw before; the ceiling mirrors the feed
 * marketplace. Every page costs ONE batched avatar resolution regardless of size.
 */
const DEFAULT_PACK_PAGE_SIZE = 50;
const MAX_PACK_PAGE_SIZE = 100;

/**
 * A pack MIRRORED from an external network (`source_network` set) is owned
 * UPSTREAM and read-only through Mention's write API: its name + membership are
 * re-synced in place on every profile view, so a local edit would be silently
 * overwritten on the next sync. Every mutation route rejects it BEFORE the
 * ownership check — a federated pack is never editable regardless of who asks
 * (its owner is a federated Oxy user with no session, so the ownership check
 * already blocks local users; this is defence-in-depth and a clearer 403 that
 * states the real reason). Following the pack's members (`POST /:id/use`) stays
 * allowed — that is a viewer action that never mutates the pack.
 */
const FEDERATED_PACK_READONLY_MESSAGE =
  'This starter pack is mirrored from an external network and is read-only';

/**
 * `starter_packs_source_complete_check` makes the three source columns
 * all-or-nothing, so any one of them answers the question.
 */
function isFederatedPack(pack: Pick<typeof starterPacks.$inferSelect, 'sourceNetwork'>): boolean {
  return pack.sourceNetwork !== null;
}

/** Number of member avatars surfaced per pack in the list response. */
const LIST_AVATAR_LIMIT = 8;

/**
 * Escape the characters `LIKE` treats as wildcards.
 *
 * The Mongo version escaped REGEX metacharacters, which is the wrong alphabet
 * here: `%` and `_` are what `ILIKE` reads as patterns, and leaving them live
 * turns the search box into a way to match every pack in the table.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Provenance for a pack mirrored from an external network. */
interface SerializedPackSource {
  network: string;
  uri: string;
  syncedAt: Date;
}

/** A starter pack exactly as it goes on the wire. */
interface SerializedStarterPack {
  _id: string;
  id: string;
  ownerOxyUserId: string;
  name: string;
  description?: string;
  /** The membership junction, flattened back into the array the client reads. */
  memberOxyUserIds: string[];
  useCount: number;
  source?: SerializedPackSource;
  createdAt: Date;
  updatedAt: Date;
}

/** Shape of each item in the `GET /starter-packs` list response. */
interface StarterPackListItem extends SerializedStarterPack {
  memberAvatars: string[];
  memberCount: number;
}

/**
 * A member in the `GET /starter-packs/:id` detail response — the canonical Oxy
 * {@link PostUser} (Oxy owns identity, same shape as `post.user` / Who-to-follow):
 * `name.displayName`, `avatar` file id, `username`. The client renders it with
 * the same pattern (`getNormalizedUserHandle` + Bloom `ImageResolver`).
 */
type StarterPackMember = PostUser;

/**
 * Re-assemble the response body a Mongoose document produced.
 *
 * `_id` alongside `id`, because the client reads `pack._id || pack.id`
 * (`services/starterPacksService.ts`). An absent `description` is OMITTED rather
 * than sent as `null` — Mongoose's `undefined` disappeared from the JSON and
 * drizzle's `null` would not — and the three flattened source columns are folded
 * back into the `source` subdocument the guard above is named after.
 *
 * ONE field of the Mongo document does NOT come back: `usedByOxyUserIds`. It is
 * now `starter_pack_uses`, a junction whose whole point is that it never has to
 * be read in full, and shipping it would mean loading every user who has ever
 * used every pack on the page. Nothing consumes it — `StarterPackSummary` in
 * `packages/frontend/services/starterPacksService.ts` does not declare it and no
 * call site in this repo reads it off a response; `useCount` carries the same
 * cardinality it was ever read for.
 */
function serializePack(
  row: typeof starterPacks.$inferSelect,
  memberOxyUserIds: string[],
): SerializedStarterPack {
  return {
    _id: row.id,
    id: row.id,
    ownerOxyUserId: row.ownerOxyUserId,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    memberOxyUserIds,
    useCount: row.useCount,
    ...(row.sourceNetwork !== null && row.sourceUri !== null && row.sourceSyncedAt !== null
      ? { source: { network: row.sourceNetwork, uri: row.sourceUri, syncedAt: row.sourceSyncedAt } }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The member ids a client sent, in the order they sent them: non-empty strings
 * only, deduplicated.
 *
 * Mongo stored the raw array, so a repeated id simply sat there twice. The
 * junction's `(pack_id, oxy_user_id)` unique constraint refuses that outright,
 * so the duplicate is collapsed HERE — keeping the first occurrence, which is
 * what preserves the arrangement the owner chose.
 */
function normalizeMemberIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value === 'string' && value.length > 0) seen.add(value);
  }
  return Array.from(seen);
}

/** Members of the given packs, keyed by pack id, each in the owner's order. */
async function loadMembersByPack(
  db: DatabaseOrTransaction,
  packIds: string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (packIds.length === 0) return grouped;

  // `inArray`, never a hand-built `= any(${ids})`: a raw JS array interpolated
  // into `sql` binds as a ROW constructor, and Postgres rejects it at runtime.
  const rows = await db
    .select({ packId: starterPackMembers.packId, oxyUserId: starterPackMembers.oxyUserId })
    .from(starterPackMembers)
    .where(inArray(starterPackMembers.packId, packIds))
    .orderBy(asc(starterPackMembers.packId), asc(starterPackMembers.position));

  for (const row of rows) {
    const bucket = grouped.get(row.packId);
    if (bucket) bucket.push(row.oxyUserId);
    else grouped.set(row.packId, [row.oxyUserId]);
  }
  return grouped;
}

/**
 * Rewrite a pack's membership so it is exactly `memberIds`, in that order.
 *
 * DELETE-then-INSERT, two statements inside the caller's transaction.
 * `(pack_id, position)` is UNIQUE, so REORDERING in place (`update … set
 * position = …`) collides with whichever row still holds the target position —
 * Postgres checks a unique constraint per statement, not at commit, so even one
 * multi-row `UPDATE` fails. The delete runs first, in its own statement, so the
 * insert sees no old rows and `position` runs 0…n-1 with nothing to collide
 * with.
 */
async function replaceMembers(tx: Transaction, packId: string, memberIds: string[]): Promise<void> {
  await tx.delete(starterPackMembers).where(eq(starterPackMembers.packId, packId));
  if (memberIds.length === 0) return;
  await tx.insert(starterPackMembers).values(
    memberIds.map((oxyUserId, position) => ({ packId, oxyUserId, position })),
  );
}

/**
 * Resolve a starter pack's members to ready-to-render summaries server-side, in
 * the SAME order the owner arranged them.
 *
 * Member identity MUST be resolved on the backend: {@link resolveUserSummaries}
 * goes through the Oxy bulk `/users/by-ids` endpoint, which requires a SERVICE
 * credential that only exists on the server. A browser client calling
 * `getUsersByIds` silently resolves nothing (the SDK swallows the missing-token
 * error and returns `[]`), which is exactly what left the detail screen showing
 * "0 accounts". This mirrors the list path's {@link enrichWithMemberAvatars}.
 *
 * Ids that don't resolve to a real Oxy user (deleted/unknown — the resolver
 * returns its degraded fallback summary) are skipped so we never render a
 * nameless/handle-less placeholder row. Best-effort: a resolution failure
 * returns `[]` so the detail still renders (the caller keeps `memberCount`).
 */
async function hydratePackMembers(memberIds: string[]): Promise<StarterPackMember[]> {
  if (memberIds.length === 0) return [];
  try {
    const summaries = await resolveUserSummaries(memberIds);
    const members: StarterPackMember[] = [];
    for (const id of memberIds) {
      const resolved = summaries.get(id);
      if (!resolved || isFallbackUserSummary(resolved.user)) continue;
      members.push(resolved.user);
    }
    return members;
  } catch (error) {
    logger.warn('[StarterPacks] Failed to resolve members for detail', {
      memberCount: memberIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
}

/**
 * Enrich a page of starter packs with `memberAvatars` (≤8 resolved URLs) and
 * `memberCount`.
 *
 * Avatar resolution is delegated to {@link resolveUserSummaries} — the SAME
 * batched, Redis-backed author-summary resolver the feed hydration path uses.
 * This collapses what was a per-unique-member `oxy.getUserById` HTTP fan-out
 * (the classic N+1, served only by the SDK's separate 5-minute in-process cache)
 * into a single bulk service call for the cache misses, and unifies the avatar
 * staleness window with the feed (one 10-minute cache instead of two divergent
 * ones). The resolved summary already carries the final, ready-to-render avatar
 * URL, so the output is identical.
 */
async function enrichWithMemberAvatars(
  packs: SerializedStarterPack[],
): Promise<StarterPackListItem[]> {
  const uniqueMemberIds = new Set<string>();
  for (const pack of packs) {
    for (const id of pack.memberOxyUserIds.slice(0, LIST_AVATAR_LIMIT)) {
      uniqueMemberIds.add(id);
    }
  }

  const avatarById = new Map<string, string>();
  if (uniqueMemberIds.size > 0) {
    try {
      const summaries = await resolveUserSummaries(Array.from(uniqueMemberIds));
      for (const [memberId, { user }] of summaries) {
        // Bare Oxy file id (or mirrored URL) — the client resolves it via Bloom's
        // ImageResolver, same as every other avatar surface.
        if (typeof user.avatar === 'string' && user.avatar.length > 0) {
          avatarById.set(memberId, user.avatar);
        }
      }
    } catch (error) {
      // Avatar enrichment is best-effort: a resolution failure must never fail
      // the list response — packs still render with `memberCount` and no avatars.
      logger.warn('[StarterPacks] Failed to resolve member avatars for list', {
        memberCount: uniqueMemberIds.size,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  return packs.map((pack) => {
    const memberAvatars = pack.memberOxyUserIds
      .slice(0, LIST_AVATAR_LIMIT)
      .map((id) => avatarById.get(id))
      .filter((url): url is string => typeof url === 'string');
    return { ...pack, memberAvatars, memberCount: pack.memberOxyUserIds.length };
  });
}

/**
 * The outcome of a write that first has to find the pack, refuse a mirrored one
 * and check its owner.
 *
 * Returned rather than thrown so the transaction is not used for control flow:
 * a `throw` here would roll back a transaction that had done nothing wrong and
 * arrive at the catch block as an indistinguishable 500.
 */
type PackWriteOutcome =
  | { kind: 'notFound' }
  | { kind: 'readOnly' }
  | { kind: 'forbidden' }
  | { kind: 'tooManyMembers' }
  | {
      kind: 'ok';
      pack: typeof starterPacks.$inferSelect;
      previousMemberIds: string[];
      memberIds: string[];
    };

/**
 * Answer every refusal outcome; `false` when the write went through.
 *
 * A type predicate rather than a plain boolean, so the caller's `if (…) return`
 * narrows `outcome` to the success variant — otherwise every call site needs a
 * second, unreachable `kind !== 'ok'` guard purely to satisfy the compiler.
 */
function respondToRefusal(
  res: Response,
  outcome: PackWriteOutcome,
): outcome is Exclude<PackWriteOutcome, { kind: 'ok' }> {
  if (outcome.kind === 'notFound') {
    res.status(404).json({ error: 'Starter pack not found' });
    return true;
  }
  if (outcome.kind === 'readOnly') {
    res.status(403).json({ error: FEDERATED_PACK_READONLY_MESSAGE });
    return true;
  }
  if (outcome.kind === 'forbidden') {
    res.status(403).json({ error: 'Not allowed' });
    return true;
  }
  if (outcome.kind === 'tooManyMembers') {
    res.status(400).json({ error: `Maximum ${STARTER_PACK_MAX_MEMBERS} members allowed` });
    return true;
  }
  return false;
}

// Create starter pack
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const parsed = createStarterPackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const { name, description, memberOxyUserIds } = parsed.data;

    const members = normalizeMemberIds(memberOxyUserIds);
    if (members.length > STARTER_PACK_MAX_MEMBERS) {
      return res.status(400).json({ error: `Maximum ${STARTER_PACK_MAX_MEMBERS} members allowed` });
    }

    const pack = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(starterPacks)
        .values({
          ownerOxyUserId: userId,
          name,
          // NULL, never `''` — an empty string is a VALUE, and the client's
          // `if (pack.description)` would render an empty field instead of none.
          description: description ? description : null,
          // The three `source_*` columns are deliberately NOT written here and
          // stay NULL. `starter_packs_source_uri_key` is a PARTIAL unique index
          // over non-null `source_uri`, so writing `''` would make every locally
          // created pack collide with every other one. Mention's write API
          // cannot mint a mirrored pack at all — only the atproto connector does.
        })
        .returning();
      await replaceMembers(tx, row.id, members);
      return row;
    });

    syncPackEndorsements(pack.id);
    invalidateCurationScores(members);
    res.status(201).json(serializePack(pack, members));
  } catch (error) {
    logger.error('[StarterPacks] Failed to create starter pack', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to create starter pack' });
  }
});

// List starter packs — public read with OPTIONAL auth. Three modes:
//   - mine=true       → the authenticated viewer's own packs (empty when anon)
//   - userId=<oxyId>  → a specific owner's packs (a profile's "Starter Packs" tab)
//   - neither         → public discovery (all packs, most-used first)
// Discovery additionally accepts `excludeUsed=true` (see below).
// `page`/`limit` paginate every mode on the same stable sort, and `total` is the
// real match count — so a caller can page past the first window instead of being
// silently capped at it. The write routes below enforce auth internally.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    const mine = queryString(req.query.mine);
    const search = queryString(req.query.search);
    const ownerId = queryString(req.query.userId)?.trim() ?? '';

    const page = Math.max(1, queryInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, queryInt(req.query.limit) || DEFAULT_PACK_PAGE_SIZE), MAX_PACK_PAGE_SIZE);
    const offset = (page - 1) * limit;

    const conditions: Array<SQL | undefined> = [];
    let ownerScoped = false;
    if (mine === 'true') {
      // "My packs" requires identity; an anonymous viewer owns nothing.
      if (!viewerId) return res.json({ items: [], total: 0, page, totalPages: 0 });
      conditions.push(eq(starterPacks.ownerOxyUserId, viewerId));
      ownerScoped = true;
    } else if (ownerId.length > 0) {
      // A specific profile's packs (foreign-profile tab passes `userId`).
      conditions.push(eq(starterPacks.ownerOxyUserId, ownerId));
      ownerScoped = true;
    } else if (viewerId && queryString(req.query.excludeUsed) === 'true') {
      // Discovery for a recommendation surface (the feed interstitial): never
      // suggest a pack the viewer already owns or has already used. Anonymous
      // viewers have used nothing, so the param is ignored for them.
      //
      // `notExists` over the junction is the port of Mongo's
      // `usedByOxyUserIds: { $ne: viewerId }` on the member ARRAY. The subquery
      // correlates on `starter_packs.id`, which is the shape that returns an
      // empty result with NO error when the outer column renders unqualified —
      // drizzle's query builder qualifies every column it emits, and the suite
      // asserts a NON-EMPTY, exactly-enumerated result rather than "no rows".
      conditions.push(ne(starterPacks.ownerOxyUserId, viewerId));
      conditions.push(
        notExists(
          getDb()
            .select({ one: sql`1` })
            .from(starterPackUses)
            .where(
              and(
                eq(starterPackUses.packId, starterPacks.id),
                eq(starterPackUses.oxyUserId, viewerId),
              ),
            ),
        ),
      );
    }
    if (search) {
      const pattern = likeContains(search);
      conditions.push(
        or(ilike(starterPacks.name, pattern), ilike(starterPacks.description, pattern)),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Owner-scoped views read best most-recent-first; discovery ranks by usage.
    // `id` breaks ties so the sort is TOTAL — without it two packs sharing a
    // timestamp (or a `useCount`, which most packs do) could swap places between
    // requests and make an offset page repeat or skip a row.
    const orderBy = ownerScoped
      ? [desc(starterPacks.updatedAt), desc(starterPacks.id)]
      : [desc(starterPacks.useCount), desc(starterPacks.createdAt), desc(starterPacks.id)];

    const db = getDb();
    const [rows, [counted]] = await Promise.all([
      db.select().from(starterPacks).where(where).orderBy(...orderBy).limit(limit).offset(offset),
      // `::int` so postgres.js hands back a NUMBER: a bare `count(*)` is a
      // bigint, which the driver returns as a STRING, and `total` would silently
      // change type on the wire.
      db.select({ total: sql<number>`count(*)::int` }).from(starterPacks).where(where),
    ]);

    const membersByPack = await loadMembersByPack(db, rows.map((row) => row.id));
    const enriched = await enrichWithMemberAvatars(
      rows.map((row) => serializePack(row, membersByPack.get(row.id) ?? [])),
    );
    res.json({ items: enriched, total: counted.total, page, totalPages: Math.ceil(counted.total / limit) });
  } catch (error) {
    logger.error('[StarterPacks] Failed to list starter packs', { userId: req.user?.id, error });
    res.status(500).json({ error: 'Failed to list starter packs' });
  }
});

// Get starter pack — public read with optional auth (shared links resolve while
// the session is still restoring). No owner-only fields are exposed.
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const db = getDb();
    const [pack] = await db
      .select()
      .from(starterPacks)
      .where(eq(starterPacks.id, String(req.params.id)))
      .limit(1);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    // Hydrate members server-side (the browser has no service credential for the
    // bulk user lookup). `members` is ordered to match `memberOxyUserIds`;
    // `memberCount` mirrors the list response for label parity.
    const membersByPack = await loadMembersByPack(db, [pack.id]);
    const memberIds = membersByPack.get(pack.id) ?? [];
    const members = await hydratePackMembers(memberIds);
    res.json({ ...serializePack(pack, memberIds), members, memberCount: memberIds.length });
  } catch (error) {
    logger.error('[StarterPacks] Failed to get starter pack', { packId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to get starter pack' });
  }
});

// Update starter pack
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = updateStarterPackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const { name, description, memberOxyUserIds } = parsed.data;
    const replacesMembers = Array.isArray(memberOxyUserIds);

    const outcome = await getDb().transaction<PackWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(starterPacks)
        .where(eq(starterPacks.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (isFederatedPack(existing)) return { kind: 'readOnly' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const membersByPack = await loadMembersByPack(tx, [existing.id]);
      const previousMemberIds = membersByPack.get(existing.id) ?? [];
      const memberIds = replacesMembers ? normalizeMemberIds(memberOxyUserIds) : previousMemberIds;
      if (memberIds.length > STARTER_PACK_MAX_MEMBERS) return { kind: 'tooManyMembers' };

      // Built from LITERAL keys only. Drizzle keys `set()` by column PROPERTY
      // name and silently ignores an unknown one — writing nothing and throwing
      // nothing — so an update object assembled from request keys would be a
      // dropped write nobody notices.
      await tx
        .update(starterPacks)
        .set({
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description: description ? description : null }),
          // Always stamped, matching Mongoose's `save()`: the previous route
          // bumped `updatedAt` on every PUT whether or not a field changed, and
          // `updated_at` is the sort key the owner-scoped listing pages on.
          updatedAt: new Date(),
        })
        .where(eq(starterPacks.id, existing.id));

      if (replacesMembers) {
        await replaceMembers(tx, existing.id, memberIds);
      }

      const [pack] = await tx
        .select()
        .from(starterPacks)
        .where(eq(starterPacks.id, existing.id))
        .limit(1);
      return { kind: 'ok', pack, previousMemberIds, memberIds };
    });

    if (respondToRefusal(res, outcome)) return;

    if (replacesMembers) {
      syncPackMembershipChange(
        outcome.pack.id,
        outcome.pack.ownerOxyUserId,
        outcome.previousMemberIds,
        outcome.memberIds,
      );
      invalidateCurationScores(outcome.previousMemberIds, outcome.memberIds);
    } else {
      syncPackEndorsements(outcome.pack.id);
    }
    res.json(serializePack(outcome.pack, outcome.memberIds));
  } catch (error) {
    logger.error('[StarterPacks] Failed to update starter pack', { userId: req.user?.id, packId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to update starter pack' });
  }
});

// Delete starter pack
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const outcome = await getDb().transaction<PackWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(starterPacks)
        .where(eq(starterPacks.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (isFederatedPack(existing)) return { kind: 'readOnly' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      // Capture members BEFORE the delete so their endorsements can be retracted;
      // `starter_pack_members` cascades with the pack and is gone afterwards.
      const membersByPack = await loadMembersByPack(tx, [existing.id]);
      await tx.delete(starterPacks).where(eq(starterPacks.id, existing.id));
      const memberIds = membersByPack.get(existing.id) ?? [];
      return { kind: 'ok', pack: existing, previousMemberIds: memberIds, memberIds };
    });

    if (respondToRefusal(res, outcome)) return;

    void endorsementSignalService
      .syncScopeRemoval('starterPack', outcome.pack.id, outcome.pack.ownerOxyUserId, outcome.memberIds)
      .catch((error) => logger.warn('[StarterPacks] endorsement retraction failed', error));
    invalidateCurationScores(outcome.memberIds);
    res.json({ success: true });
  } catch (error) {
    logger.error('[StarterPacks] Failed to delete starter pack', { userId: req.user?.id, packId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to delete starter pack' });
  }
});

// Add members
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { userIds } = req.body || {};

    const outcome = await getDb().transaction<PackWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(starterPacks)
        .where(eq(starterPacks.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (isFederatedPack(existing)) return { kind: 'readOnly' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const membersByPack = await loadMembersByPack(tx, [existing.id]);
      const previousMemberIds = membersByPack.get(existing.id) ?? [];
      // Existing members keep their positions and the new ones are APPENDED —
      // the same result `new Set([...existing, ...incoming])` produced.
      const memberIds = Array.from(new Set([...previousMemberIds, ...normalizeMemberIds(userIds)]));
      if (memberIds.length > STARTER_PACK_MAX_MEMBERS) return { kind: 'tooManyMembers' };
      await replaceMembers(tx, existing.id, memberIds);
      return { kind: 'ok', pack: existing, previousMemberIds, memberIds };
    });

    if (respondToRefusal(res, outcome)) return;

    syncPackEndorsements(outcome.pack.id);
    invalidateCurationScores(outcome.previousMemberIds, outcome.memberIds);
    res.json(serializePack(outcome.pack, outcome.memberIds));
  } catch (error) {
    logger.error('[StarterPacks] Failed to add members', { userId: req.user?.id, packId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members
router.delete('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { userIds } = req.body || {};

    const outcome = await getDb().transaction<PackWriteOutcome>(async (tx) => {
      const [existing] = await tx
        .select()
        .from(starterPacks)
        .where(eq(starterPacks.id, String(req.params.id)))
        .limit(1);
      if (!existing) return { kind: 'notFound' };
      if (isFederatedPack(existing)) return { kind: 'readOnly' };
      if (existing.ownerOxyUserId !== userId) return { kind: 'forbidden' };

      const membersByPack = await loadMembersByPack(tx, [existing.id]);
      const previousMemberIds = membersByPack.get(existing.id) ?? [];
      const toRemove = new Set(normalizeMemberIds(userIds));
      const memberIds = previousMemberIds.filter((id) => !toRemove.has(id));
      await replaceMembers(tx, existing.id, memberIds);
      return { kind: 'ok', pack: existing, previousMemberIds, memberIds };
    });

    if (respondToRefusal(res, outcome)) return;

    syncPackMembershipChange(
      outcome.pack.id,
      outcome.pack.ownerOxyUserId,
      outcome.previousMemberIds,
      outcome.memberIds,
    );
    invalidateCurationScores(outcome.previousMemberIds, outcome.memberIds);
    res.json(serializePack(outcome.pack, outcome.memberIds));
  } catch (error) {
    logger.error('[StarterPacks] Failed to remove members', { userId: req.user?.id, packId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Use starter pack (record the use once per user, return member IDs for
// client-side following)
router.post('/:id/use', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const outcome = await getDb().transaction(async (tx) => {
      const [pack] = await tx
        .select()
        .from(starterPacks)
        .where(eq(starterPacks.id, String(req.params.id)))
        .limit(1);
      if (!pack) return null;

      // The junction row IS the idempotency key: `starter_pack_uses_pack_id_oxy_user_id_key`
      // rejects a second use by the same viewer, so `onConflictDoNothing` returning
      // nothing is exactly Mongo's `usedByOxyUserIds: { $ne: userId }` filter failing
      // to match — and the counter moves only when a row was really inserted.
      const inserted = await tx
        .insert(starterPackUses)
        .values({ packId: pack.id, oxyUserId: userId })
        .onConflictDoNothing()
        .returning({ id: starterPackUses.id });

      const membersByPack = await loadMembersByPack(tx, [pack.id]);
      const memberOxyUserIds = membersByPack.get(pack.id) ?? [];
      if (inserted.length === 0) {
        return { alreadyUsed: true, memberOxyUserIds, useCount: pack.useCount };
      }

      const [updated] = await tx
        .update(starterPacks)
        .set({ useCount: sql`${starterPacks.useCount} + 1` })
        .where(eq(starterPacks.id, pack.id))
        .returning({ useCount: starterPacks.useCount });
      return { alreadyUsed: false, memberOxyUserIds, useCount: updated.useCount };
    });

    if (!outcome) return res.status(404).json({ error: 'Starter pack not found' });

    if (outcome.alreadyUsed) {
      // Already used — report the same data without re-incrementing.
      return res.json({
        memberOxyUserIds: outcome.memberOxyUserIds,
        useCount: outcome.useCount,
        alreadyUsed: true,
      });
    }

    // `useCount` actually moved, so every member's curation score changed.
    invalidateCurationScores(outcome.memberOxyUserIds);
    res.json({ memberOxyUserIds: outcome.memberOxyUserIds, useCount: outcome.useCount });
  } catch (error) {
    logger.error('[StarterPacks] Failed to use starter pack', { userId: req.user?.id, packId: String(req.params.id), error });
    res.status(500).json({ error: 'Failed to use starter pack' });
  }
});

export default router;
