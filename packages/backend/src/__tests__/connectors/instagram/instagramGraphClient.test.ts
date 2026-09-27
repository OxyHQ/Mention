import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Graph client's contract with the outside world: what it sends (token in a
 * header, never the URL), how it classifies Meta's errors, and when it refuses
 * to send at all (flag off, budget, throttle, bad token). Meta is never called —
 * the SSRF-safe single-hop fetch is the mocked boundary.
 */

const TOKEN = 'EAAG-test-token-that-must-never-leak';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  logs: [] as Array<{ level: string; args: unknown[] }>,
  /** Not ready by default: the process-local path. The Redis cases swap in a fake. */
  redis: { isReady: false } as Record<string, unknown>,
}));

vi.mock('../../../utils/safeUpstreamFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/safeUpstreamFetch')>()),
  fetchUpstreamSingleHop: h.fetch,
}));

vi.mock('../../../utils/redis', () => ({ getRedisClient: () => h.redis }));

vi.mock('../../../utils/logger', () => {
  const record = (level: string) => (...args: unknown[]) => { h.logs.push({ level, args }); };
  return { logger: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') } };
});

vi.mock('../../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      instagramGraph: { enabled: true, businessAccountId: '17841400000000000', apiVersion: 'v23.0', followBackfillLimit: 50 },
    },
    getMetaGraphAccessToken: () => TOKEN,
  };
});

import { config } from '../../../config';
import {
  buildBusinessDiscoveryFields,
  classifyGraphError,
  fetchBusinessDiscovery,
  InstagramGraphError,
  resetGraphClientForTests,
} from '../../../connectors/instagram/graphClient';
import {
  acquireCallBudget,
  decayedUsagePct,
  decideBudget,
  localBudgetStateForTests,
  parseAppUsageHeader,
  recordThrottle,
  resetLocalBudgetStateForTests,
  throttleBackoffMs,
} from '../../../connectors/instagram/usageBudget';
import {
  BACKGROUND_TOKEN_FLOOR,
  GRAPH_CALL_BUCKET_CAPACITY,
} from '../../../connectors/instagram/constants';
import { IMAGE, REAL_PAGING, ZUCK_PROFILE } from './fixtures/graphSnapshot';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  h.fetch.mockResolvedValueOnce({
    status,
    headers,
    response: Readable.from([Buffer.from(JSON.stringify(body))]),
  });
}

function graphError(code: number, subcode?: number) {
  return { error: { message: 'Invalid parameter', type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'x' } };
}

beforeEach(() => {
  h.redis = { isReady: false };
  h.fetch.mockReset();
  h.logs.length = 0;
  resetLocalBudgetStateForTests();
  resetGraphClientForTests();
  config.instagramGraph.enabled = true;
});

afterEach(() => {
  config.instagramGraph.enabled = true;
});

describe('a successful Business Discovery call', () => {
  it('parses the real response shape, including the cursor-only paging', async () => {
    respond(200, { business_discovery: { ...ZUCK_PROFILE, media: { data: [IMAGE], paging: REAL_PAGING } }, id: '1784' });
    const profile = await fetchBusinessDiscovery('zuck', { kind: 'interactive', media: { limit: 1 } });
    expect(profile.id).toBe(ZUCK_PROFILE.id);
    expect(profile.username).toBe('zuck');
    expect(profile.media?.data).toHaveLength(1);
    expect(profile.media?.after).toBe(REAL_PAGING.cursors.after);
  });

  it('sends the token in the Authorization header and never in the URL', async () => {
    respond(200, { business_discovery: { ...ZUCK_PROFILE } });
    await fetchBusinessDiscovery('zuck', { kind: 'interactive' });
    const [url, options] = h.fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v23\.0\/17841400000000000\?fields=/);
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain('access_token');
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(decodeURIComponent(url)).toContain('business_discovery.username(zuck)');
  });

  it('feeds x-app-usage into the shared budget', async () => {
    respond(200, { business_discovery: { ...ZUCK_PROFILE } }, { 'x-app-usage': '{"call_count":81,"total_cputime":3,"total_time":7}' });
    await fetchBusinessDiscovery('zuck', { kind: 'interactive' });
    expect(localBudgetStateForTests().usagePct).toBe(81);
  });

  it('builds the media edge with limit and cursor', () => {
    expect(buildBusinessDiscoveryFields('plex', { limit: 12, after: 'QVFI' }))
      .toMatch(/^business_discovery\.username\(plex\)\{id,username,.*,media\.limit\(12\)\.after\(QVFI\)\{id,caption,/);
  });
});

describe('Meta error classes', () => {
  it('reads 110 / 2207013 as "not a business account"', async () => {
    respond(400, graphError(110, 2207013));
    await expect(fetchBusinessDiscovery('someone', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'not_business' });
  });

  it.each([4, 17])('reads code %i as throttled and backs off', async (code) => {
    respond(400, graphError(code));
    await expect(fetchBusinessDiscovery('zuck', { kind: 'background' })).rejects.toMatchObject({ kind: 'throttled' });
    // The backoff now withholds the next call without it reaching Meta.
    await expect(fetchBusinessDiscovery('zuck', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'throttled' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads 190 as an invalid token: pauses calls and logs ONCE, loudly, without the token', async () => {
    respond(401, graphError(190));
    await expect(fetchBusinessDiscovery('zuck', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'token_invalid' });
    await expect(fetchBusinessDiscovery('zuck', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'token_invalid' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const errors = h.logs.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  it('classifies anything else as a plain API error', () => {
    expect(classifyGraphError(500, graphError(1))).toMatchObject({ kind: 'api', code: 1 });
    expect(classifyGraphError(429, {})).toMatchObject({ kind: 'throttled' });
  });

  it('never echoes a transport error (which could name the request) into its message', async () => {
    h.fetch.mockRejectedValueOnce(new Error(`connect ECONNREFUSED https://graph.facebook.com/?access_token=${TOKEN}`));
    const error = await fetchBusinessDiscovery('zuck', { kind: 'interactive' }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(InstagramGraphError);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('refusing to call', () => {
  it('is inert with the flag off — no request at all', async () => {
    config.instagramGraph.enabled = false;
    await expect(fetchBusinessDiscovery('zuck', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'disabled' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('refuses a username that could rewrite the fields expression', async () => {
    await expect(fetchBusinessDiscovery('zuck){id}', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('stops background calls above 75% usage but still serves a profile view', async () => {
    respond(200, { business_discovery: { ...ZUCK_PROFILE } }, { 'x-app-usage': '{"call_count":80}' });
    await fetchBusinessDiscovery('zuck', { kind: 'interactive' });

    await expect(fetchBusinessDiscovery('zuck', { kind: 'background' })).rejects.toMatchObject({ kind: 'budget' });
    respond(200, { business_discovery: { ...ZUCK_PROFILE } });
    await expect(fetchBusinessDiscovery('zuck', { kind: 'interactive' })).resolves.toMatchObject({ id: ZUCK_PROFILE.id });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('the call-token bucket (taken BEFORE a call, not learned after it)', () => {
  function okResponses(n: number) {
    for (let i = 0; i < n; i += 1) respond(200, { business_discovery: { ...ZUCK_PROFILE } });
  }

  it('caps a burst of interactive calls at the bucket, without sending the rest', async () => {
    okResponses(GRAPH_CALL_BUCKET_CAPACITY);
    for (let i = 0; i < GRAPH_CALL_BUCKET_CAPACITY; i += 1) {
      await fetchBusinessDiscovery('zuck', { kind: 'interactive' });
    }
    // x-app-usage never reported anything high: the bucket alone stops this.
    await expect(fetchBusinessDiscovery('zuck', { kind: 'interactive' })).rejects.toMatchObject({ kind: 'budget' });
    expect(h.fetch).toHaveBeenCalledTimes(GRAPH_CALL_BUCKET_CAPACITY);
  });

  it('keeps the floor of the bucket for readers: background calls stop above it', async () => {
    const drain = GRAPH_CALL_BUCKET_CAPACITY - BACKGROUND_TOKEN_FLOOR;
    for (let i = 0; i < drain; i += 1) expect(await acquireCallBudget('interactive')).toBeNull();
    expect(await acquireCallBudget('background')).toBe('tokens');
    expect(await acquireCallBudget('interactive')).toBeNull();
  });

  it('uses ONE atomic Redis script per call when Redis is up — no read-modify-write', async () => {
    const evalCalls: Array<{ keys: string[]; arguments: string[] }> = [];
    h.redis = {
      isReady: true,
      mGet: vi.fn(async () => [null, null, null]),
      eval: vi.fn(async (_script: string, options: { keys: string[]; arguments: string[] }) => {
        evalCalls.push(options);
        return 1;
      }),
      set: vi.fn(),
      get: vi.fn(),
    };
    expect(await acquireCallBudget('background')).toBeNull();
    expect(await acquireCallBudget('interactive')).toBeNull();
    expect(evalCalls.map((call) => call.arguments[2])).toEqual([String(BACKGROUND_TOKEN_FLOOR), '0']);
    expect(h.redis.get).not.toHaveBeenCalled();
    expect(h.redis.set).not.toHaveBeenCalled();
  });

  it('counts throttle strikes with an atomic INCR shared by every task', async () => {
    let strikes = 2;
    h.redis = {
      isReady: true,
      incr: vi.fn(async () => { strikes += 1; return strikes; }),
      pExpire: vi.fn(),
      set: vi.fn(),
    };
    const until = await recordThrottle();
    expect(h.redis.incr).toHaveBeenCalledTimes(1);
    expect(until - Date.now()).toBeGreaterThan(throttleBackoffMs(3) - 1_000);
    expect(h.redis.set).toHaveBeenCalledWith('instagram-graph:throttled-until', String(until), { PX: throttleBackoffMs(3) });
  });
});

describe('the budget arithmetic', () => {
  const base = { usagePct: 0, usageAt: 0, throttledUntil: 0, tokenInvalidUntil: 0 };

  it('takes the highest of the three x-app-usage figures', () => {
    expect(parseAppUsageHeader('{"call_count":10,"total_cputime":40,"total_time":22}')).toBe(40);
    expect(parseAppUsageHeader('garbage')).toBeUndefined();
    expect(parseAppUsageHeader(undefined)).toBeUndefined();
  });

  it('decays an observation across the one-hour window', () => {
    const now = 10_000_000;
    expect(decayedUsagePct(80, now, now)).toBe(80);
    expect(decayedUsagePct(80, now - 30 * 60_000, now)).toBeCloseTo(40);
    expect(decayedUsagePct(80, now - 61 * 60_000, now)).toBe(0);
  });

  it('orders refusals: token, then throttle, then usage', () => {
    const now = 10_000_000;
    expect(decideBudget({ ...base, tokenInvalidUntil: now + 1, throttledUntil: now + 1 }, 'interactive', now)).toBe('token_invalid');
    expect(decideBudget({ ...base, throttledUntil: now + 1 }, 'interactive', now)).toBe('throttled');
    expect(decideBudget({ ...base, usagePct: 76, usageAt: now }, 'background', now)).toBe('usage');
    expect(decideBudget({ ...base, usagePct: 76, usageAt: now }, 'interactive', now)).toBeNull();
    expect(decideBudget({ ...base, usagePct: 96, usageAt: now }, 'interactive', now)).toBe('usage');
  });

  it('doubles the throttle backoff per strike, up to its ceiling', () => {
    expect(throttleBackoffMs(2)).toBe(2 * throttleBackoffMs(1));
    expect(throttleBackoffMs(50)).toBe(throttleBackoffMs(49));
  });
});
