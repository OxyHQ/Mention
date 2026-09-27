import { getRedisClient } from '../../utils/redis';
import { logger } from '../../utils/logger';
import {
  BACKGROUND_USAGE_CEILING_PCT,
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
 * so the state that decides "may this call go out?" lives in Redis when Redis is
 * reachable (every API task and the periodic worker see one budget) and in this
 * process otherwise (a degraded boot or local dev — each process then guards
 * only itself, which is the best available answer, not a correct one).
 *
 * Three independent reasons to hold a call back:
 *
 *  - USAGE: the last `x-app-usage` percentage (the max of `call_count`,
 *    `total_cputime`, `total_time`), decayed linearly across Meta's one-hour
 *    window. Background work stops at {@link BACKGROUND_USAGE_CEILING_PCT} so a
 *    profile view still has room; interactive work stops near the ceiling.
 *  - THROTTLED: Meta answered a rate-limit code; back off exponentially.
 *  - TOKEN INVALID: code 190; stop calling for an hour instead of burning the
 *    error budget on a token that cannot work.
 */

export type GraphCallKind = 'interactive' | 'background';

export type BudgetRefusal = 'usage' | 'throttled' | 'token_invalid';

export interface BudgetState {
  /** Highest `x-app-usage` percentage at `observedAt`. */
  usagePct: number;
  observedAt: number;
  throttledUntil: number;
  throttleStrikes: number;
  tokenInvalidUntil: number;
}

const REDIS_KEY = 'instagram-graph:budget';
/** Long enough to outlive the longest pause the state can express. */
const REDIS_TTL_SECONDS = Math.ceil(Math.max(USAGE_WINDOW_MS, THROTTLE_BACKOFF_MAX_MS, TOKEN_INVALID_PAUSE_MS) / 1000) * 2;

const EMPTY_STATE: BudgetState = {
  usagePct: 0,
  observedAt: 0,
  throttledUntil: 0,
  throttleStrikes: 0,
  tokenInvalidUntil: 0,
};

let localState: BudgetState = { ...EMPTY_STATE };

function readyRedis(): ReturnType<typeof getRedisClient> | null {
  try {
    const redis = getRedisClient();
    return redis?.isReady ? redis : null;
  } catch {
    return null;
  }
}

function coerceState(raw: unknown): BudgetState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_STATE };
  const record = raw as Record<string, unknown>;
  const num = (key: keyof BudgetState): number => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    usagePct: num('usagePct'),
    observedAt: num('observedAt'),
    throttledUntil: num('throttledUntil'),
    throttleStrikes: num('throttleStrikes'),
    tokenInvalidUntil: num('tokenInvalidUntil'),
  };
}

export async function readBudgetState(): Promise<BudgetState> {
  const redis = readyRedis();
  if (redis) {
    try {
      const raw = await redis.get(REDIS_KEY);
      if (raw) return coerceState(JSON.parse(raw));
      return { ...EMPTY_STATE };
    } catch (err) {
      logger.debug('[instagram] budget read from Redis failed; using process state', err);
    }
  }
  return { ...localState };
}

async function writeBudgetState(state: BudgetState): Promise<void> {
  localState = { ...state };
  const redis = readyRedis();
  if (!redis) return;
  try {
    await redis.set(REDIS_KEY, JSON.stringify(state), { EX: REDIS_TTL_SECONDS });
  } catch (err) {
    logger.debug('[instagram] budget write to Redis failed; kept process state', err);
  }
}

async function updateBudgetState(mutate: (state: BudgetState) => BudgetState): Promise<void> {
  await writeBudgetState(mutate(await readBudgetState()));
}

/** The usage percentage NOW, decayed from the last observation. */
export function effectiveUsagePct(state: BudgetState, now = Date.now()): number {
  if (state.observedAt <= 0) return 0;
  const age = Math.max(0, now - state.observedAt);
  if (age >= USAGE_WINDOW_MS) return 0;
  return state.usagePct * (1 - age / USAGE_WINDOW_MS);
}

/** Pure decision over a state snapshot — exported for tests. */
export function decideBudget(state: BudgetState, kind: GraphCallKind, now = Date.now()): BudgetRefusal | null {
  if (state.tokenInvalidUntil > now) return 'token_invalid';
  if (state.throttledUntil > now) return 'throttled';
  const ceiling = kind === 'background' ? BACKGROUND_USAGE_CEILING_PCT : INTERACTIVE_USAGE_CEILING_PCT;
  return effectiveUsagePct(state, now) >= ceiling ? 'usage' : null;
}

/** May a call of this kind go out now? `null` = yes, otherwise why not. */
export async function checkBudget(kind: GraphCallKind): Promise<BudgetRefusal | null> {
  return decideBudget(await readBudgetState(), kind);
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

/** Record a response's usage header; a successful call also clears throttle strikes. */
export async function recordUsage(header: string | string[] | undefined, succeeded: boolean): Promise<void> {
  const pct = parseAppUsageHeader(header);
  if (pct === undefined && !succeeded) return;
  await updateBudgetState((state) => ({
    ...state,
    ...(pct !== undefined ? { usagePct: pct, observedAt: Date.now() } : {}),
    ...(succeeded ? { throttleStrikes: 0 } : {}),
  }));
}

/** Meta throttled us: back off exponentially per consecutive strike. */
export async function recordThrottle(): Promise<number> {
  let until = 0;
  await updateBudgetState((state) => {
    const strikes = state.throttleStrikes + 1;
    const backoff = Math.min(THROTTLE_BACKOFF_BASE_MS * 2 ** (strikes - 1), THROTTLE_BACKOFF_MAX_MS);
    until = Date.now() + backoff;
    return { ...state, throttleStrikes: strikes, throttledUntil: until };
  });
  return until;
}

/** The token was rejected (code 190): pause every call. */
export async function recordTokenInvalid(): Promise<void> {
  await updateBudgetState((state) => ({ ...state, tokenInvalidUntil: Date.now() + TOKEN_INVALID_PAUSE_MS }));
}

/** Test seam: forget the process-local state. */
export function resetLocalBudgetStateForTests(): void {
  localState = { ...EMPTY_STATE };
}
