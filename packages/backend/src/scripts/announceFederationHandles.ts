/**
 * One-shot: tell remote servers when local accounts' fediverse handles move to,
 * or back from, the handle domain (`FEDERATION_HANDLE_DOMAIN`,
 * docs/mention-org-domain-move.md, Phase 3).
 *
 * WHY. A remote server only re-verifies a handle when it re-reads the actor. Our
 * WebFinger and actor document change the moment the configuration does, but a
 * follower's copy of the account would keep `@user@mention.earth` until its own
 * refresh. One `Update(Person)` to each switched account's followers makes them
 * re-read it: Mastodon 4.7+ renames the account in place on that Update (it reads
 * the actor's FEP-2c59 `webfinger`, re-runs WebFinger, `rename_account!`); 4.6 and
 * older refresh on their own schedule and merge the account row they hold
 * (`AccountMergingWorker`). Either way no follow, post or id moves.
 *
 * WHAT IT DOES. For each candidate account it compares the handle the policy
 * gives it NOW with the handle last announced (a Redis hash; an account never
 * announced is taken to be known on FEDERATION_DOMAIN, which is what every remote
 * server already holds). Only a difference is announced, through the SAME
 * `Update(Person)` path a profile edit uses (`deliveryService.federateActorUpdate`:
 * the fediverse-sharing gate, the follower fan-out deduplicated per shared inbox,
 * the durable delivery queue and its retries). The record is written after the
 * Update is queued, so a killed run re-sends at most one Update per account.
 *
 * Candidates: the accounts in `FEDERATION_HANDLE_DOMAIN_ACCOUNTS` (every local
 * federating account for `all`), plus every account with a recorded announcement.
 *
 * ROLLBACK uses the same run. Unset `FEDERATION_HANDLE_DOMAIN` (or empty the list)
 * and deploy, then run this again: every recorded account now differs from its
 * record, gets one Update announcing `@user@mention.earth` again, and its record is
 * cleared.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: it counts and sends nothing.
 *  2. `assertAdminMutationAllowed` refuses a sending run until the operator names
 *     the script back.
 *  3. Idempotent: a second run with the same configuration sends nothing.
 *  4. Paced: `BATCH_SIZE` accounts (default 25) per batch, `PAUSE_MS` (default
 *     10 s) between batches, and no batch starts while the delivery queue holds
 *     more than `MAX_DELIVERY_BACKLOG` jobs (default 5000). Delivery itself runs in
 *     the service's delivery workers at their own concurrency.
 *  5. One run at a time (a Redis lock), and a sending run without Redis is
 *     refused: without the record it could not be idempotent.
 *  6. `MAX_RUNTIME_MS` (default 50 min) stops it between batches with exit 75 (work
 *     left, run it again), inside the one-shot runner's 55-minute timeout.
 *
 *   bun packages/backend/dist/src/scripts/announceFederationHandles.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=announceFederationHandles \
 *     bun packages/backend/dist/src/scripts/announceFederationHandles.js
 */

import { once } from 'node:events';
import { asc, gt } from 'drizzle-orm';
import { ALL_HANDLE_DOMAIN_ACCOUNTS } from '../config';
import {
  type FederationHandlePolicy,
  federationHandlePolicy,
  isHandlePolicyActive,
  localAcct,
} from '../connectors/activitypub/federationHandleDomain';
import { hasActorKeyPair } from '../db/federation/actorKeyPairRepository';
import { connectPostgres, getDb } from '../db/postgres';
import { actorKeyPairs } from '../db/schema/federation';
import { logger } from '../utils/logger';
import { getRedisClient, type RedisClientType } from '../utils/redis';
import { sleep as realSleep } from '../utils/sleep';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { EXIT_BACKFILL_STOPPED } from './lib/backfillThrottle';

export const SCRIPT_NAME = 'announceFederationHandles';

/** Hash: Oxy user id → the acct (`user@domain`, lowercase) last announced for it. */
export const ANNOUNCED_HANDLES_KEY = 'ap:federation-handle:announced';
const RUN_LOCK_KEY = 'ap:federation-handle:announce-lock';
const RUN_LOCK_TTL_SECONDS = 60 * 60;
const KEY_PAIR_PAGE = 500;
const REDIS_READY_TIMEOUT_MS = 30_000;

/** The announcement record. */
export interface AnnouncedHandleStore {
  all(): Promise<Map<string, string>>;
  set(oxyUserId: string, acct: string): Promise<void>;
  delete(oxyUserId: string): Promise<void>;
  /** Take the one-run lock; false when another run holds it. */
  lock(): Promise<boolean>;
  unlock(): Promise<void>;
}

/** Everything the run reaches outside itself, injected so every branch is tested without I/O. */
export interface AnnounceDependencies {
  policy: FederationHandlePolicy;
  store: AnnouncedHandleStore;
  /** Every local federating account (an `actor_key_pairs` row), in pages of Oxy user ids. */
  localActorIdPages(): AsyncIterable<string[]>;
  /** The Oxy user id of a local federating account by username, or null (unknown, or never federated). */
  localActorIdForUsername(username: string): Promise<string | null>;
  /** Current usernames by Oxy user id; an id missing from the map could not be read. */
  usernamesFor(oxyUserIds: readonly string[]): Promise<Map<string, string>>;
  isSharingEnabled(oxyUserId: string): Promise<boolean>;
  /** Queue one `Update(Person)` to the account's followers. */
  announce(oxyUserId: string, username: string): Promise<void>;
  /** Jobs waiting in the delivery queue, or null when it cannot be read (no queue). */
  deliveryBacklog(): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface AnnounceOptions {
  dryRun: boolean;
  batchSize: number;
  pauseMs: number;
  maxDeliveryBacklog: number;
  backlogPollMs: number;
  maxRuntimeMs: number;
}

export interface AnnounceResult {
  /** Accounts considered: the rollout plus every recorded account, once each. */
  candidates: number;
  /** Updates queued. Always 0 on a dry run. */
  announced: number;
  /** Updates a sending run would queue. */
  wouldAnnounce: number;
  /** Already announced with the handle they have now. */
  unchanged: number;
  /** Records removed for accounts back on FEDERATION_DOMAIN with nothing to send. */
  cleared: number;
  /** Sharing off: nothing federates for them, so nothing is sent and the record is kept. */
  sharingOff: number;
  /** Usernames that did not resolve, or ids Oxy could not read: retried by the next run. */
  unresolvable: number;
  /** An announcement that threw: retried by the next run. */
  failed: number;
  /** Stopped at MAX_RUNTIME_MS with candidates left. */
  stopped: boolean;
}

export const DEFAULT_ANNOUNCE_OPTIONS: Omit<AnnounceOptions, 'dryRun'> = {
  batchSize: 25,
  pauseMs: 10_000,
  maxDeliveryBacklog: 5_000,
  backlogPollMs: 30_000,
  maxRuntimeMs: 50 * 60 * 1000,
};

/** The candidate accounts, in a stable order: the rollout first, then the recorded ones. */
async function collectCandidates(
  deps: AnnounceDependencies,
  recorded: ReadonlyMap<string, string>,
  result: AnnounceResult,
): Promise<string[]> {
  const ids = new Set<string>();
  const { policy } = deps;
  if (isHandlePolicyActive(policy)) {
    if (policy.accounts === ALL_HANDLE_DOMAIN_ACCOUNTS) {
      for await (const page of deps.localActorIdPages()) {
        for (const id of page) ids.add(id);
      }
    } else {
      for (const username of policy.accounts) {
        const id = await deps.localActorIdForUsername(username);
        if (id) ids.add(id);
        else result.unresolvable += 1;
      }
    }
  }
  for (const id of recorded.keys()) ids.add(id);
  return [...ids];
}

/** Wait until the delivery queue has room, or the deadline passes (false). */
async function waitForDeliveryRoom(
  deps: AnnounceDependencies,
  options: AnnounceOptions,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    const backlog = await deps.deliveryBacklog();
    if (backlog === null || backlog <= options.maxDeliveryBacklog) return true;
    if (deps.now() + options.backlogPollMs >= deadline) return false;
    logger.info(`[${SCRIPT_NAME}] delivery queue is full; waiting`, {
      backlog,
      maxDeliveryBacklog: options.maxDeliveryBacklog,
    });
    await deps.sleep(options.backlogPollMs);
  }
}

async function announceBatch(
  ids: readonly string[],
  recorded: Map<string, string>,
  deps: AnnounceDependencies,
  options: AnnounceOptions,
  result: AnnounceResult,
): Promise<void> {
  const usernames = await deps.usernamesFor(ids);
  for (const id of ids) {
    const username = usernames.get(id)?.trim();
    if (!username) {
      result.unresolvable += 1;
      continue;
    }
    const desired = localAcct(deps.policy, username).toLowerCase();
    const known = `${username}@${deps.policy.federationDomain}`.toLowerCase();
    const previous = recorded.get(id) ?? known;
    if (previous === desired) {
      result.unchanged += 1;
      if (recorded.has(id) && desired === known && !options.dryRun) {
        await deps.store.delete(id);
        recorded.delete(id);
        result.cleared += 1;
      }
      continue;
    }
    if (!(await deps.isSharingEnabled(id))) {
      result.sharingOff += 1;
      continue;
    }
    if (options.dryRun) {
      result.wouldAnnounce += 1;
      continue;
    }
    try {
      await deps.announce(id, username);
    } catch (error) {
      result.failed += 1;
      logger.warn(`[${SCRIPT_NAME}] announcement failed; the next run retries it`, {
        oxyUserId: id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (desired === known) {
      await deps.store.delete(id);
      recorded.delete(id);
    } else {
      await deps.store.set(id, desired);
      recorded.set(id, desired);
    }
    result.announced += 1;
  }
}

/** Announce every handle that changed since it was last announced. */
export async function announceFederationHandles(
  options: AnnounceOptions,
  deps: AnnounceDependencies,
): Promise<AnnounceResult> {
  const result: AnnounceResult = {
    candidates: 0,
    announced: 0,
    wouldAnnounce: 0,
    unchanged: 0,
    cleared: 0,
    sharingOff: 0,
    unresolvable: 0,
    failed: 0,
    stopped: false,
  };
  if (!options.dryRun && !(await deps.store.lock())) {
    throw new Error(`[${SCRIPT_NAME}] another run is in progress (${RUN_LOCK_KEY})`);
  }
  try {
    const deadline = deps.now() + options.maxRuntimeMs;
    const recorded = await deps.store.all();
    const candidates = await collectCandidates(deps, recorded, result);
    result.candidates = candidates.length;
    for (let start = 0; start < candidates.length; start += options.batchSize) {
      if (start > 0 && options.pauseMs > 0) await deps.sleep(options.pauseMs);
      if (deps.now() >= deadline || !(await waitForDeliveryRoom(deps, options, deadline))) {
        result.stopped = true;
        break;
      }
      await announceBatch(
        candidates.slice(start, start + options.batchSize),
        recorded,
        deps,
        options,
        result,
      );
    }
  } finally {
    if (!options.dryRun) await deps.store.unlock();
  }
  logger.info(`[${SCRIPT_NAME}] complete`, {
    dryRun: options.dryRun,
    federationDomain: deps.policy.federationDomain,
    handleDomain: deps.policy.handleDomain,
    rollout:
      deps.policy.accounts === ALL_HANDLE_DOMAIN_ACCOUNTS
        ? ALL_HANDLE_DOMAIN_ACCOUNTS
        : deps.policy.accounts.size,
    ...result,
  });
  return result;
}

/** The announcement record in Redis. */
export function redisAnnouncedHandleStore(redis: RedisClientType): AnnouncedHandleStore {
  return {
    all: async () => new Map(Object.entries(await redis.hGetAll(ANNOUNCED_HANDLES_KEY))),
    set: async (oxyUserId, acct) => {
      await redis.hSet(ANNOUNCED_HANDLES_KEY, oxyUserId, acct);
    },
    delete: async (oxyUserId) => {
      await redis.hDel(ANNOUNCED_HANDLES_KEY, oxyUserId);
    },
    lock: async () =>
      (await redis.set(RUN_LOCK_KEY, String(process.pid), {
        NX: true,
        EX: RUN_LOCK_TTL_SECONDS,
      })) === 'OK',
    unlock: async () => {
      await redis.del(RUN_LOCK_KEY);
    },
  };
}

/** An integer option from the environment, inside its bounds, or the default. */
export function integerOption(
  raw: string | undefined,
  fallback: number,
  { minimum, maximum }: { minimum: number; maximum: number },
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`[${SCRIPT_NAME}] expected an integer in ${minimum}..${maximum}, got ${raw}`);
  }
  return value;
}

/** The options a run reads from its environment. */
export function announceOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AnnounceOptions {
  const defaults = DEFAULT_ANNOUNCE_OPTIONS;
  return {
    dryRun: (env.DRY_RUN ?? 'true') !== 'false',
    batchSize: integerOption(env.BATCH_SIZE, defaults.batchSize, { minimum: 1, maximum: 200 }),
    pauseMs: integerOption(env.PAUSE_MS, defaults.pauseMs, { minimum: 0, maximum: 600_000 }),
    maxDeliveryBacklog: integerOption(env.MAX_DELIVERY_BACKLOG, defaults.maxDeliveryBacklog, {
      minimum: 0,
      maximum: 1_000_000,
    }),
    backlogPollMs: defaults.backlogPollMs,
    maxRuntimeMs: integerOption(env.MAX_RUNTIME_MS, defaults.maxRuntimeMs, {
      minimum: 1_000,
      maximum: 6 * 60 * 60 * 1000,
    }),
  };
}

/** The production dependencies. Imported lazily so the suites load none of them. */
async function productionDependencies(redis: RedisClientType): Promise<AnnounceDependencies> {
  const [{ deliveryService }, { resolveOxyUser }, { isFediverseSharingEnabled }, lookup, queues] =
    await Promise.all([
      import('../connectors/activitypub/delivery.service.js'),
      import('../connectors/activitypub/constants.js'),
      import('../services/federation/fediverseSharing.js'),
      import('../utils/oxyUserLookup.js'),
      import('../queue/queues.js'),
    ]);
  return {
    policy: federationHandlePolicy,
    store: redisAnnouncedHandleStore(redis),
    async *localActorIdPages() {
      let after = '';
      for (;;) {
        const rows = await getDb()
          .select({ id: actorKeyPairs.id, oxyUserId: actorKeyPairs.oxyUserId })
          .from(actorKeyPairs)
          .where(gt(actorKeyPairs.id, after))
          .orderBy(asc(actorKeyPairs.id))
          .limit(KEY_PAIR_PAGE);
        if (rows.length === 0) return;
        after = rows[rows.length - 1].id;
        yield rows.map((row) => row.oxyUserId);
      }
    },
    async localActorIdForUsername(username) {
      const user = await resolveOxyUser(username);
      const id = user ? String(user.id ?? user._id ?? '') : '';
      return id && (await hasActorKeyPair(id)) ? id : null;
    },
    async usernamesFor(oxyUserIds) {
      const found = await lookup.lookupOxyUsers(oxyUserIds, 'federation.handle_announcement');
      const usernames = new Map<string, string>();
      for (const user of found.found) {
        const id = String(user.id ?? user._id ?? '');
        if (id && user.username) usernames.set(id, user.username);
      }
      return usernames;
    },
    isSharingEnabled: (oxyUserId) => isFediverseSharingEnabled(oxyUserId),
    announce: (oxyUserId, username) => deliveryService.federateActorUpdate(oxyUserId, username),
    async deliveryBacklog() {
      const queue = queues.getDeliveryQueue();
      return queue ? await queue.getWaitingCount() : null;
    },
    sleep: (ms) => realSleep(ms),
    now: () => Date.now(),
  };
}

async function main(): Promise<number> {
  const options = announceOptionsFromEnv(process.env);
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: options.dryRun });
  await connectPostgres();
  const redis = getRedisClient();
  if (!redis.isReady) {
    await once(redis, 'ready', { signal: AbortSignal.timeout(REDIS_READY_TIMEOUT_MS) });
  }
  logger.info(`[${SCRIPT_NAME}] starting`, { ...options });
  const result = await announceFederationHandles(options, await productionDependencies(redis));
  if (result.failed > 0) return 1;
  return result.stopped ? EXIT_BACKFILL_STOPPED : 0;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await closeAdminScriptResources();
      process.exit(code);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
