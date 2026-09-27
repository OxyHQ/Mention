import { getRedisClient } from '../../utils/redis';
import { logger } from '../../utils/logger';
import {
  BACKGROUND_TOKEN_FLOOR,
  BACKGROUND_USAGE_CEILING_PCT,
  GRAPH_CALL_BUCKET_CAPACITY,
  GRAPH_CALLS_PER_HOUR,
  INTERACTIVE_USAGE_CEILING_PCT,
  THROTTLE_BACKOFF_BASE_MS,
  THROTTLE_BACKOFF_MAX_MS,
  TOKEN_INVALID_PAUSE_MS,
  USAGE_WINDOW_MS,
} from './constants';

/**
 * The shared spending guard for Meta's Graph API budget.
 *
 * One token serves the whole fleet and Meta counts ~200 calls/hour against it,
 * so every decision lives in Redis when Redis is reachable (every API task and
 * every worker see ONE budget) and in this process otherwise (a degraded boot
 * or local dev — each process then guards only itself, the best available
 * answer, not a correct one).
 *
 * Every write is a single atomic Redis operation — nothing here reads a value,
 * changes it in the process and writes it back, so two tasks cannot lose each
 * other's update:
 *
 *  - CALL TOKENS: a token bucket (Lua, so check-and-take is one step) refilled
 *    at {@link GRAPH_CALLS_PER_HOUR}. A call must TAKE a token BEFORE it is sent;
 *    `x-app-usage` only reports calls after the fact, so it cannot stop a burst
 *    of follows on its own. Background calls may not draw the bucket below
 *    {@link BACKGROUND_TOKEN_FLOOR}, which keeps that share for readers.
 *  - USAGE: the last `x-app-usage` percentage (max of `call_count`,
 *    `total_cputime`, `total_time`), decayed across Meta's one-hour window —
 *    the authoritative signal when Meta counts differently from us.
 *  - THROTTLED: Meta answered a rate-limit code; strikes are an atomic INCR and
 *    the backoff doubles per strike.
 *  - TOKEN INVALID: code 190; every call pauses for an hour.
 */

export type GraphCallKind = 'interactive' | 'background';

export type BudgetRefusal = 'usage' | 'throttled' | 'token_invalid' | 'tokens';

const KEY_BUCKET = 'instagram-graph:bucket';
const KEY_USAGE = 'instagram-graph:usage';
const KEY_STRIKES = 'instagram-graph:throttle-strikes';
const KEY_THROTTLED_UNTIL = 'instagram-graph:throttled-until';
const KEY_TOKEN_INVALID_UNTIL = 'instagram-graph:token-invalid-until';

/** Tokens refilled per millisecond. */
const REFILL_PER_MS = GRAPH_CALLS_PER_HOUR / (60 * 60 * 1000);

/** Idle keys expire; an absent bucket is a full one. */
const BUCKET_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Take one token unless that would leave fewer than `floor`. Redis `TIME` is the
 * clock, so tasks with skewed clocks share one refill schedule. Returns 1 when a
 * token was taken, 0 otherwise.
 */
const TAKE_TOKEN_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local floor = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill)
local taken = 0
if tokens - 1 >= floor then
  tokens = tokens - 1
  taken = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttl)
return taken
`;

/** Process-local fallback state (no Redis). Same algorithm, same meaning. */
interface LocalState {
  tokens: number;
  tokensAt: number;
  usagePct: number;
  usageAt: number;
  strikes: number;
  throttledUntil: number;
  tokenInvalidUntil: number;
}

function freshLocalState(): LocalState {
  return {
    tokens: GRAPH_CALL_BUCKET_CAPACITY,
    tokensAt: Date.now(),
    usagePct: 0,
    usageAt: 0,
    strikes: 0,
    throttledUntil: 0,
    tokenInvalidUntil: 0,
  };
}

let local: LocalState = freshLocalState();

type Redis = ReturnType<typeof getRedisClient>;

function readyRedis(): Redis | null {
  try {
    const redis = getRedisClient();
    return redis?.isReady ? redis : null;
  } catch {
    return null;
  }
}

/** The usage percentage NOW, decayed linearly from an observation. */
export function decayedUsagePct(usagePct: number, observedAt: number, now = Date.now()): number {
  if (observedAt <= 0) return 0;
  const age = Math.max(0, now - observedAt);
  if (age >= USAGE_WINDOW_MS) return 0;
  return usagePct * (1 - age / USAGE_WINDOW_MS);
}

/** The pure, pre-token part of the decision — exported for tests. */
export function decideBudget(
  state: { usagePct: number; usageAt: number; throttledUntil: number; tokenInvalidUntil: number },
  kind: GraphCallKind,
  now = Date.now(),
): Exclude<BudgetRefusal, 'tokens'> | null {
  if (state.tokenInvalidUntil > now) return 'token_invalid';
  if (state.throttledUntil > now) return 'throttled';
  const ceiling = kind === 'background' ? BACKGROUND_USAGE_CEILING_PCT : INTERACTIVE_USAGE_CEILING_PCT;
  return decayedUsagePct(state.usagePct, state.usageAt, now) >= ceiling ? 'usage' : null;
}

function floorFor(kind: GraphCallKind): number {
  return kind === 'background' ? BACKGROUND_TOKEN_FLOOR : 0;
}

/** Local token take — exported for tests. */
export function takeLocalToken(kind: GraphCallKind, now = Date.now()): boolean {
  const tokens = Math.min(GRAPH_CALL_BUCKET_CAPACITY, local.tokens + Math.max(0, now - local.tokensAt) * REFILL_PER_MS);
  local.tokensAt = now;
  if (tokens - 1 < floorFor(kind)) {
    local.tokens = tokens;
    return false;
  }
  local.tokens = tokens - 1;
  return true;
}

function num(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readRedisGates(redis: Redis): Promise<{ usagePct: number; usageAt: number; throttledUntil: number; tokenInvalidUntil: number }> {
  const [usage, throttledUntil, tokenInvalidUntil] = await redis.mGet([KEY_USAGE, KEY_THROTTLED_UNTIL, KEY_TOKEN_INVALID_UNTIL]);
  let usagePct = 0;
  let usageAt = 0;
  if (usage) {
    try {
      const parsed = JSON.parse(usage) as { pct?: unknown; at?: unknown };
      usagePct = num(parsed.pct);
      usageAt = num(parsed.at);
    } catch {
      // A garbled value is no observation.
    }
  }
  return { usagePct, usageAt, throttledUntil: num(throttledUntil), tokenInvalidUntil: num(tokenInvalidUntil) };
}

/**
 * May a call of this kind go out now? `null` = yes, AND a call token has been
 * taken for it; otherwise why not (no token is taken on a refusal).
 */
export async function acquireCallBudget(kind: GraphCallKind): Promise<BudgetRefusal | null> {
  const redis = readyRedis();
  if (redis) {
    try {
      const refusal = decideBudget(await readRedisGates(redis), kind);
      if (refusal) return refusal;
      const taken = await redis.eval(TAKE_TOKEN_SCRIPT, {
        keys: [KEY_BUCKET],
        arguments: [
          String(GRAPH_CALL_BUCKET_CAPACITY),
          String(REFILL_PER_MS),
          String(floorFor(kind)),
          String(BUCKET_TTL_MS),
        ],
      });
      return Number(taken) === 1 ? null : 'tokens';
    } catch (err) {
      logger.debug('[instagram] budget check against Redis failed; using process state', err);
    }
  }
  const refusal = decideBudget(
    { usagePct: local.usagePct, usageAt: local.usageAt, throttledUntil: local.throttledUntil, tokenInvalidUntil: local.tokenInvalidUntil },
    kind,
  );
  if (refusal) return refusal;
  return takeLocalToken(kind) ? null : 'tokens';
}

/**
 * Parse Meta's `x-app-usage` header (`{"call_count":12,"total_cputime":3,
 * "total_time":5}`) into its highest percentage; undefined when absent/garbled.
 */
export function parseAppUsageHeader(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const values = ['call_count', 'total_cputime', 'total_time']
      .map((key) => parsed[key])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : undefined;
  } catch {
    return undefined;
  }
}

/** Record a response: its usage header (one SET), and — on success — clear the throttle strikes (one DEL). */
export async function recordUsage(header: string | string[] | undefined, succeeded: boolean): Promise<void> {
  const pct = parseAppUsageHeader(header);
  const now = Date.now();
  if (pct !== undefined) {
    local.usagePct = pct;
    local.usageAt = now;
  }
  if (succeeded) local.strikes = 0;
  const redis = readyRedis();
  if (!redis) return;
  try {
    if (pct !== undefined) {
      await redis.set(KEY_USAGE, JSON.stringify({ pct, at: now }), { PX: USAGE_WINDOW_MS });
    }
    if (succeeded) await redis.del(KEY_STRIKES);
  } catch (err) {
    logger.debug('[instagram] usage write to Redis failed; kept process state', err);
  }
}

/** The backoff for the `strikes`-th consecutive throttle — exported for tests. */
export function throttleBackoffMs(strikes: number): number {
  return Math.min(THROTTLE_BACKOFF_BASE_MS * 2 ** (Math.max(1, strikes) - 1), THROTTLE_BACKOFF_MAX_MS);
}

/** Meta throttled us: one atomic INCR decides the strike, the backoff follows from it. */
export async function recordThrottle(): Promise<number> {
  const redis = readyRedis();
  let strikes: number;
  if (redis) {
    try {
      strikes = await redis.incr(KEY_STRIKES);
      await redis.pExpire(KEY_STRIKES, THROTTLE_BACKOFF_MAX_MS * 2);
      const until = Date.now() + throttleBackoffMs(strikes);
      // Strikes only grow (INCR), so the task holding the highest strike also
      // writes the longest backoff; overwriting is the right merge.
      await redis.set(KEY_THROTTLED_UNTIL, String(until), { PX: throttleBackoffMs(strikes) });
      local.throttledUntil = Math.max(local.throttledUntil, until);
      return until;
    } catch (err) {
      logger.debug('[instagram] throttle write to Redis failed; using process state', err);
    }
  }
  local.strikes += 1;
  strikes = local.strikes;
  const until = Date.now() + throttleBackoffMs(strikes);
  local.throttledUntil = Math.max(local.throttledUntil, until);
  return until;
}

/** The token was rejected (code 190): pause every call. */
export async function recordTokenInvalid(): Promise<void> {
  const until = Date.now() + TOKEN_INVALID_PAUSE_MS;
  local.tokenInvalidUntil = until;
  const redis = readyRedis();
  if (!redis) return;
  try {
    await redis.set(KEY_TOKEN_INVALID_UNTIL, String(until), { PX: TOKEN_INVALID_PAUSE_MS });
  } catch (err) {
    logger.debug('[instagram] token-invalid write to Redis failed; kept process state', err);
  }
}

/** Test seam: forget the process-local state. */
export function resetLocalBudgetStateForTests(): void {
  local = freshLocalState();
}

/** Test seam: the process-local state. */
export function localBudgetStateForTests(): Readonly<LocalState> {
  return local;
}
