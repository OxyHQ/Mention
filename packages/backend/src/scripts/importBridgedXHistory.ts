/**
 * ONE-SHOT: import an X account's history through the bird.makeup bridge.
 *
 * An X account reaches Mention as a bird.makeup actor, and bird.makeup gives no
 * history: every actor serves a bare `{"type":"Collection"}` outbox, so a newly
 * followed X profile shows only what is delivered after the follow (Oxy's bridge
 * policy records this). What bird.makeup DOES serve is any single tweet by id —
 * `https://bird.makeup/users/<handle>/statuses/<tweetId>` returns the same Note it
 * would deliver, with quotes, media and `inReplyTo` structured. So given the
 * list of tweet ids, every post can be imported through the SAME signed,
 * SSRF-safe, deduplicated path ingest already uses for a boosted original, a
 * reply ancestor and a quoted note (`outboxSyncService.ensureQuotedNote`). The
 * post, its author's identity in Oxy, its quote and its parent chain all come
 * from the bridge; nothing here writes a post body of its own.
 *
 * The id list is a committed fixture (`fixtures/xHistory<Account>.json`), so
 * what is imported is exactly what was reviewed. It was read from the account's
 * public timeline; each entry is either the account's own post or a retweet.
 *
 * RETWEETS. Delivered retweets cannot be shown: bird.makeup flattens them into a
 * Note opening `RT: @original` that carries no reference to the original, and
 * ingest drops them (`flattenedRetweet.ts`). The fixture DOES know the original
 * — its author and id — so a retweet is imported as what it is: the original
 * tweet is imported under its own author (which also brings that author's
 * account into Oxy), and the account gets a boost of it through
 * `importAnnounce`, the same call a federated `Announce` reaches. The boost's
 * activity id is minted here (`tag:` URI, never fetchable) because the bridge
 * never published one; it only has to be stable, so a re-run dedupes on it.
 * The boost is dated with the original's date: the timeline the ids came from
 * does not say when the retweet happened.
 *
 * IDEMPOTENT. A post is matched by its activity id before any fetch and a boost
 * by its minted id, so a second run imports nothing. bird.makeup answers 404
 * intermittently for live statuses, so an item that fails is retried, and a run
 * that still leaves failures exits {@link EXIT_INCOMPLETE} — re-run it.
 *
 * DRY RUN (the default) fetches nothing and writes nothing: it validates the
 * fixture, resolves which items are already held, and reports the plan.
 */

import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources, registerAdminScriptServices } from './lib/adminScriptLifecycle';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { actorService } from '../connectors/activitypub/actor.service';
import { outboxSyncService } from '../connectors/activitypub/outbox.service';
import { mapWithConcurrency } from '../utils/concurrency';
import enricdurang from './fixtures/xHistoryEnricdurang.json';

const SCRIPT_NAME = 'importBridgedXHistory';

/** Exit code for "some items still failed; re-run" — the split `backfillMediaMetadata` uses. */
export const EXIT_INCOMPLETE = 75;

const BRIDGE_ORIGIN = 'https://bird.makeup';

/** bird.makeup is one volunteer-run host; this is a courtesy, not a throughput knob. */
const CONCURRENCY = 3;

/** Attempts per item. One 404 from bird.makeup is not evidence a status is gone. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID = /^\d{1,20}$/;

const xHistoryItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('post'), id: z.string().regex(TWEET_ID) }),
  z.strictObject({
    kind: z.literal('repost'),
    /** The ORIGINAL tweet's id and author — what the retweet points at. */
    id: z.string().regex(TWEET_ID),
    author: z.string().regex(X_HANDLE),
    publishedAt: z.string().datetime(),
  }),
]);

export type XHistoryItem = z.infer<typeof xHistoryItemSchema>;

export const xHistoryFixtureSchema = z
  .strictObject({
    /** The account's X handle, as X spells it. */
    handle: z.string().regex(X_HANDLE),
    /** Where the id list was read from, and when. Provenance only. */
    source: z.string().min(1),
    items: z.array(xHistoryItemSchema).min(1),
  })
  .superRefine((fixture, ctx) => {
    const seen = new Set<string>();
    fixture.items.forEach((item, index) => {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key))
        ctx.addIssue({ code: 'custom', path: ['items', index], message: `duplicate ${key}` });
      seen.add(key);
    });
  });

export type XHistoryFixture = z.infer<typeof xHistoryFixtureSchema>;

export const X_HISTORY_FIXTURES: Readonly<Record<string, unknown>> = { enricdurang };

/** bird.makeup addresses every account in lower case (Oxy's bridge policy: `caseRule: lowercase`). */
export function bridgeActorUri(handle: string): string {
  return `${BRIDGE_ORIGIN}/users/${handle.toLowerCase()}`;
}

export function bridgeStatusUri(handle: string, tweetId: string): string {
  return `${bridgeActorUri(handle)}/statuses/${tweetId}`;
}

/** The boost's minted activity id: stable per (account, original), and never fetchable. */
export function repostActivityId(handle: string, originalTweetId: string): string {
  return `tag:mention.earth,2026:x-history/${handle.toLowerCase()}/repost/${originalTweetId}`;
}

export interface XHistoryImportResult {
  items: number;
  posts: number;
  reposts: number;
  alreadyHeld: number;
  imported: number;
  failed: number;
  failedItems: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function heldActivityIds(ids: string[]): Promise<Set<string>> {
  const held = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await getDb()
      .select({ activityId: posts.federationActivityId })
      .from(posts)
      .where(inArray(posts.federationActivityId, ids.slice(i, i + 500)));
    for (const row of rows) if (row.activityId) held.add(row.activityId);
  }
  return held;
}

async function withRetries(
  attempt: () => Promise<boolean>,
  retryDelayMs: number,
): Promise<boolean> {
  for (let n = 1; n <= ATTEMPTS; n++) {
    try {
      if (await attempt()) return true;
    } catch (err) {
      logger.warn('[XHistory] item attempt threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (n < ATTEMPTS) await sleep(retryDelayMs * n);
  }
  return false;
}

export async function importBridgedXHistory(
  fixture: XHistoryFixture,
  opts: { dryRun?: boolean; retryDelayMs?: number } = {},
): Promise<XHistoryImportResult> {
  const dryRun = opts.dryRun ?? true;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const accountUri = bridgeActorUri(fixture.handle);

  const keyOf = (item: XHistoryItem) =>
    item.kind === 'post'
      ? bridgeStatusUri(fixture.handle, item.id)
      : repostActivityId(fixture.handle, item.id);
  const held = await heldActivityIds(fixture.items.map(keyOf));
  const pending = fixture.items.filter((item) => !held.has(keyOf(item)));

  const result: XHistoryImportResult = {
    items: fixture.items.length,
    posts: fixture.items.filter((item) => item.kind === 'post').length,
    reposts: fixture.items.filter((item) => item.kind === 'repost').length,
    alreadyHeld: fixture.items.length - pending.length,
    imported: 0,
    failed: 0,
    failedItems: [],
  };
  logger.info('[XHistory] plan', {
    dryRun,
    handle: fixture.handle,
    ...result,
    pending: pending.length,
  });
  if (dryRun || pending.length === 0) return result;

  // The boost owner. Resolving the account's own actor also refreshes its Oxy
  // identity, so a booster that never resolved before is minted here.
  const accountOxyUserId = await actorService.resolveActorOxyUserId(accountUri);
  if (!accountOxyUserId)
    throw new Error(`[XHistory] ${accountUri} does not resolve to an Oxy user`);

  let done = 0;
  await mapWithConcurrency(pending, CONCURRENCY, async (item) => {
    const ok = await withRetries(async () => {
      if (item.kind === 'post') {
        return (
          (await outboxSyncService.ensureQuotedNote(bridgeStatusUri(fixture.handle, item.id))) !==
          null
        );
      }
      const activityId = repostActivityId(fixture.handle, item.id);
      const created = await outboxSyncService.importAnnounce(
        {
          id: activityId,
          type: 'Announce',
          actor: accountUri,
          published: item.publishedAt,
          url: `https://x.com/${item.author}/status/${item.id}`,
        },
        bridgeStatusUri(item.author, item.id),
        accountOxyUserId,
      );
      // `false` is also "already exists" — a concurrent or earlier attempt.
      return created || (await heldActivityIds([activityId])).has(activityId);
    }, retryDelayMs);
    if (ok) result.imported++;
    else {
      result.failed++;
      result.failedItems.push(`${item.kind}:${item.id}`);
    }
    if (++done % 100 === 0)
      logger.info('[XHistory] progress', {
        done,
        of: pending.length,
        ...result,
        failedItems: undefined,
      });
  });

  logger.info('[XHistory] complete', { handle: fixture.handle, ...result });
  return result;
}

async function main(): Promise<number> {
  const dryRun = (process.env.IMPORT_DRY_RUN ?? 'true') !== 'false';
  const account = (process.env.IMPORT_ACCOUNT ?? '').trim();
  const raw = X_HISTORY_FIXTURES[account];
  if (!raw) throw new Error(`[XHistory] no fixture for account "${account}"`);
  const fixture = xHistoryFixtureSchema.parse(raw);

  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  await registerAdminScriptServices();
  try {
    const result = await importBridgedXHistory(fixture, { dryRun });
    return result.failed > 0 ? EXIT_INCOMPLETE : 0;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      logger.error('[XHistory] import failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
