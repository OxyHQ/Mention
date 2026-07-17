import { logger } from '../../utils/logger';
import StarterPack from '../../models/StarterPack';
import { mapWithConcurrency } from '../../utils/concurrency';
import { xrpcGet } from './xrpcClient';
import { fetchAndUpsertAtprotoProfile } from './profile.mapper';
import { PUBLIC_APPVIEW, STARTER_PACK_COLLECTION } from './constants';

/**
 * Mirrors a Bluesky actor's STARTER PACKS (`app.bsky.graph.starterpack`) into
 * Mention's own `StarterPack` collection as read-only, upstream-owned packs.
 *
 * A Bluesky starter pack is a named curation whose `record.list` points at an
 * `app.bsky.graph.list` of member accounts. This module resolves each pack's
 * member DIDs to Oxy users through the SAME sanctioned identity path post mentions
 * use (`fetchAndUpsertAtprotoProfile` — creates the federated Oxy user if new),
 * then upserts a `StarterPack` owned by the profile's Oxy user, deduped on the
 * source AT-URI (`source.uri`) so a re-sync updates name + membership in place and
 * never duplicates.
 *
 * Bounded + fail-soft by construction: a hard cap on packs, list pages, per-pack
 * members and total member resolutions; each atproto GET is time-bounded by the
 * XRPC client's request deadline; and one bad pack/member never aborts the rest.
 */

// --- caps (a power user can have many packs with many members) --------------

/** Max starter packs mirrored per actor in one sync (a single AppView page). */
const MAX_STARTER_PACKS_PER_ACTOR = 25;

/** Max members mirrored per pack — matches the `StarterPack` route member cap. */
const MAX_PACK_MEMBERS = 150;

/** Members requested per `getList` page. */
const GET_LIST_PAGE_SIZE = 100;

/** Max `getList` pages walked per pack (`MAX_PACK_MEMBERS / page` + slack). */
const MAX_LIST_PAGES = 3;

/**
 * Hard ceiling on the number of DISTINCT member DIDs resolved to Oxy users per
 * actor sync. Each resolution mints/refreshes a federated Oxy user (a getProfile +
 * `PUT /users/resolve`), so this bounds the oxy-api write load a single popular
 * Bluesky account can trigger. Exceeding it warns (no silent truncation) and packs
 * beyond the budget mirror with the members that resolved.
 */
const MAX_MEMBERS_RESOLVED_PER_ACTOR = 1000;

/** How many packs to walk (`getList`) in parallel. */
const PACK_CONCURRENCY = 4;

/** How many member DIDs to resolve to Oxy users in parallel. */
const MEMBER_CONCURRENCY = 6;

// --- AppView response shapes (only the fields this connector reads) ----------

/** The `record` of an `app.bsky.graph.starterpack` view. */
interface AtprotoStarterPackRecord {
  name?: string;
  /** AT-URI of the `app.bsky.graph.list` holding the pack's members. */
  list?: string;
}

/** An item of `app.bsky.graph.getActorStarterPacks` (`starterPackViewBasic`). */
interface AtprotoStarterPackViewBasic {
  uri?: string;
  record?: AtprotoStarterPackRecord;
}

interface AtprotoGetActorStarterPacksResponse {
  starterPacks?: AtprotoStarterPackViewBasic[];
  cursor?: string;
}

/** A member row of `app.bsky.graph.getList` (`listItemView`). */
interface AtprotoListItem {
  subject?: { did?: string };
}

interface AtprotoGetListResponse {
  items?: AtprotoListItem[];
  cursor?: string;
}

/** A starter pack reduced to the fields Mention mirrors. */
export interface NormalizedStarterPackRef {
  /** The source starter-pack AT-URI (dedup key). */
  uri: string;
  name: string;
  /** AT-URI of the member list to resolve. */
  listUri: string;
}

// --- pure mappers (unit-tested) ---------------------------------------------

/**
 * Extract the mirrorable starter-pack refs from a `getActorStarterPacks` response:
 * a pack must have its own AT-URI (of the starter-pack collection), a non-empty
 * name, and a `record.list` member-list AT-URI. Capped at
 * {@link MAX_STARTER_PACKS_PER_ACTOR}. Pure.
 *
 * Uses the basic view's `record.list` directly — it is the SAME authoritative list
 * ref `getStarterPack` would return, so mirroring goes straight to `getList` and
 * skips a redundant per-pack `getStarterPack` round trip.
 */
export function extractStarterPackRefs(
  response: AtprotoGetActorStarterPacksResponse | undefined,
): NormalizedStarterPackRef[] {
  const packs = Array.isArray(response?.starterPacks) ? response.starterPacks : [];
  const refs: NormalizedStarterPackRef[] = [];
  for (const pack of packs) {
    if (refs.length >= MAX_STARTER_PACKS_PER_ACTOR) break;
    const uri = typeof pack?.uri === 'string' ? pack.uri : '';
    if (!uri.includes(`/${STARTER_PACK_COLLECTION}/`)) continue;
    const name = typeof pack.record?.name === 'string' ? pack.record.name.trim() : '';
    const listUri = typeof pack.record?.list === 'string' ? pack.record.list : '';
    if (!name || !listUri) continue;
    refs.push({ uri, name, listUri });
  }
  return refs;
}

/** Extract the member DIDs from a `getList` page, in list order (deduped). Pure. */
export function extractMemberDids(response: AtprotoGetListResponse | undefined): string[] {
  const items = Array.isArray(response?.items) ? response.items : [];
  const dids: string[] = [];
  for (const item of items) {
    const did = item?.subject?.did;
    if (typeof did === 'string' && did && !dids.includes(did)) dids.push(did);
  }
  return dids;
}

// --- network + persistence ---------------------------------------------------

/**
 * Walk a pack's member list (`getList`, paginated) and return its member DIDs in
 * list order, capped at {@link MAX_PACK_MEMBERS}. Fail-soft: a failed page stops
 * the walk and returns what was collected so far.
 */
async function collectPackMemberDids(listUri: string): Promise<string[]> {
  const dids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES && dids.length < MAX_PACK_MEMBERS; page++) {
    let response: AtprotoGetListResponse;
    try {
      response = await xrpcGet<AtprotoGetListResponse>(PUBLIC_APPVIEW, 'app.bsky.graph.getList', {
        list: listUri,
        limit: GET_LIST_PAGE_SIZE,
        cursor,
      });
    } catch (err) {
      logger.debug(`[atproto] getList failed for ${listUri}`, err);
      break;
    }

    for (const did of extractMemberDids(response)) {
      if (dids.length >= MAX_PACK_MEMBERS) break;
      if (!seen.has(did)) {
        seen.add(did);
        dids.push(did);
      }
    }

    cursor = typeof response.cursor === 'string' && response.cursor ? response.cursor : undefined;
    if (!cursor) break;
  }

  return dids;
}

/**
 * Resolve a batch of member DIDs to Oxy user ids through the shared atproto profile
 * path (mints the federated Oxy user if new), with bounded concurrency. Returns a
 * `did → oxyUserId` map; DIDs that fail to resolve to an Oxy user are absent
 * (fail-soft — a member we can't mint is simply dropped from the pack).
 */
async function resolveMemberOxyIds(dids: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (dids.length === 0) return map;

  const settled = await mapWithConcurrency(dids, MEMBER_CONCURRENCY, async (did) => {
    const actor = await fetchAndUpsertAtprotoProfile(did);
    return actor?.oxyUserId ? String(actor.oxyUserId) : undefined;
  });

  for (let i = 0; i < dids.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled' && result.value) map.set(dids[i], result.value);
  }
  return map;
}

/**
 * Upsert a single mirrored starter pack, keyed on its source AT-URI. Idempotent:
 * re-sync updates name + membership + `syncedAt` in place (never a duplicate — the
 * sparse-unique `source.uri` index is the backstop for a concurrent race).
 * Fail-soft: a persistence failure is logged and the sync moves on.
 */
async function upsertMirroredPack(
  ref: NormalizedStarterPackRef,
  ownerOxyUserId: string,
  memberOxyUserIds: string[],
): Promise<boolean> {
  try {
    await StarterPack.findOneAndUpdate(
      { 'source.uri': ref.uri },
      {
        $set: {
          ownerOxyUserId,
          name: ref.name,
          memberOxyUserIds,
          source: { network: 'atproto', uri: ref.uri, syncedAt: new Date() },
        },
      },
      { upsert: true },
    );
    return true;
  } catch (err) {
    // A concurrent sync of the same pack can race the upsert to an E11000; that is
    // benign (the other writer landed the same mirror), so it is not re-thrown.
    logger.warn(`[atproto] failed to upsert mirrored starter pack ${ref.uri}`, err);
    return false;
  }
}

/**
 * Sync an atproto actor's starter packs into Mention's `StarterPack` collection.
 *
 * `did` is the actor's DID; `ownerOxyUserId` is the ALREADY-RESOLVED Oxy user the
 * packs are owned by (the no-orphan invariant — the caller resolves the profile
 * first). Best-effort and bounded: returns the number of packs upserted; never
 * throws.
 */
export async function syncActorStarterPacks(did: string, ownerOxyUserId: string): Promise<number> {
  if (!ownerOxyUserId) {
    logger.warn(`[atproto] syncActorStarterPacks called for ${did} without a resolved Oxy owner; skipping`);
    return 0;
  }

  let response: AtprotoGetActorStarterPacksResponse;
  try {
    response = await xrpcGet<AtprotoGetActorStarterPacksResponse>(
      PUBLIC_APPVIEW,
      'app.bsky.graph.getActorStarterPacks',
      { actor: did, limit: MAX_STARTER_PACKS_PER_ACTOR },
    );
  } catch (err) {
    logger.debug(`[atproto] getActorStarterPacks failed for ${did}`, err);
    return 0;
  }

  const refs = extractStarterPackRefs(response);
  if (refs.length === 0) return 0;

  // Phase 1 — collect each pack's member DIDs (bounded pool over packs; each pack's
  // getList paging is individually bounded by the XRPC per-call deadline + caps).
  const memberSettled = await mapWithConcurrency(refs, PACK_CONCURRENCY, (ref) =>
    collectPackMemberDids(ref.listUri),
  );
  const packMemberDids: string[][] = memberSettled.map((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );

  // Phase 2 — resolve the DISTINCT member DIDs across all packs ONCE (a member in
  // several packs is minted once), bounded by a hard per-actor ceiling.
  const uniqueDids: string[] = [];
  const seenDid = new Set<string>();
  for (const dids of packMemberDids) {
    for (const did of dids) {
      if (!seenDid.has(did)) {
        seenDid.add(did);
        uniqueDids.push(did);
      }
    }
  }
  let didsToResolve = uniqueDids;
  if (uniqueDids.length > MAX_MEMBERS_RESOLVED_PER_ACTOR) {
    logger.warn(
      `[atproto] ${did} starter-pack members (${uniqueDids.length}) exceed the per-actor resolve cap ` +
        `(${MAX_MEMBERS_RESOLVED_PER_ACTOR}); mirroring only the first ${MAX_MEMBERS_RESOLVED_PER_ACTOR}`,
    );
    didsToResolve = uniqueDids.slice(0, MAX_MEMBERS_RESOLVED_PER_ACTOR);
  }
  const oxyIdByDid = await resolveMemberOxyIds(didsToResolve);

  // Phase 3 — upsert each pack with its resolved members (list order preserved).
  let upserted = 0;
  for (let i = 0; i < refs.length; i++) {
    const memberOxyUserIds: string[] = [];
    const seenMember = new Set<string>();
    for (const memberDid of packMemberDids[i]) {
      const oxyId = oxyIdByDid.get(memberDid);
      if (oxyId && !seenMember.has(oxyId)) {
        seenMember.add(oxyId);
        memberOxyUserIds.push(oxyId);
      }
    }
    const ok = await upsertMirroredPack(refs[i], ownerOxyUserId, memberOxyUserIds);
    if (ok) upserted += 1;
  }

  logger.info(`[atproto] mirrored ${upserted}/${refs.length} starter packs for ${did}`);
  return upserted;
}
