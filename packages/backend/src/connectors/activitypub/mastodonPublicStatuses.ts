import { readResponseBody, safeFetch } from '@oxy.so/core/server';
import { createCache } from '../../utils/cache';
import { logger } from '../../utils/logger';
import { USER_AGENT, isBlockedDomain } from './constants';
import { asRecord, sameOrigin } from './helpers';

/**
 * Discovery of a Mastodon account's public statuses through Mastodon's public
 * REST API, for the profiles whose outbox shows nothing.
 *
 * A Mastodon outbox can come back empty, without items, or refused (authorized
 * fetch, a server that hides it), and the profile then stays empty here even
 * though the server still lists the account's public statuses at
 * `GET /api/v1/accounts/:id/statuses`. This module only DISCOVERS what is
 * there: it yields each status's canonical ActivityPub `uri`, and the caller
 * imports that URI through the verified note path (`ensureFederatedNote`) —
 * a signed fetch from the post's own origin, author and audience checks,
 * media, dedup. Nothing is ever built from the REST JSON. So a server that
 * refuses our signed object fetches (it blocked us, or is in allowlist mode)
 * still gets nothing imported, whatever its API lists.
 *
 * The API is a Mastodon API, so it is only asked of a server whose NodeInfo
 * names Mastodon or a fork known to keep it, and whose robots.txt does not
 * close the account API to us. Everything else is never asked.
 *
 * Bounded and polite: one discovery per actor per {@link ACTOR_ATTEMPT_TTL_SECONDS},
 * at most {@link MAX_PAGES} pages, requests one at a time, and a 401/403/429/503
 * stops the run and backs the whole host off (a 429/503 for its `Retry-After`).
 */

/** NodeInfo `software.name`s whose servers serve Mastodon's public account API. */
const MASTODON_API_SOFTWARE: ReadonlySet<string> = new Set([
  // glitch-soc reports itself as `mastodon`.
  'mastodon',
  'hometown',
  'fedibird',
]);

/** Statuses asked for per page; Mastodon's own maximum is 40. */
const PAGE_SIZE = 40;

/** Pages asked for per discovery run. */
const MAX_PAGES = 2;

/** One discovery per actor in this window — the profile outbox sync's own cooldown. */
const ACTOR_ATTEMPT_TTL_SECONDS = 15 * 60;

/** How long a host that asked for credentials (401/403) is left alone. */
const AUTH_REQUIRED_BACKOFF_SECONDS = 24 * 60 * 60;

/** Bounds on a server's `Retry-After`, and the wait when it names none. */
const RETRY_AFTER_MIN_SECONDS = 60;
const RETRY_AFTER_MAX_SECONDS = 6 * 60 * 60;
const RETRY_AFTER_DEFAULT_SECONDS = 15 * 60;

/** Whether a server serves the API to us is cached this long, a failed NodeInfo read for an hour. */
const SERVER_TTL_SECONDS = 24 * 60 * 60;
const SERVER_FAILURE_TTL_SECONDS = 60 * 60;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 64 * 1024;

/** The path robots.txt is matched against: every request this module makes is under it. */
const ACCOUNT_API_PATH = '/api/v1/accounts/';

const NODEINFO_2_REL = /^https?:\/\/nodeinfo\.diaspora\.software\/ns\/schema\/2\.\d+$/;

/** Mastodon ids are numeric strings; anything else is not put in a URL path. */
const MASTODON_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** Statuses an unauthenticated reader may see, and that Mention stores as public. */
const PUBLIC_VISIBILITIES: ReadonlySet<string> = new Set(['public', 'unlisted']);

const serverCache = createCache({ name: 'FedMastodonApiServer', ttlSeconds: SERVER_TTL_SECONDS });
const throttleCache = createCache({
  name: 'FedPublicStatusesThrottle',
  ttlSeconds: ACTOR_ATTEMPT_TTL_SECONDS,
});

const serverKey = (origin: string) => `fedsync:mastodon-api-server:v1:${origin}`;
const hostBackoffKey = (origin: string) => `fedsync:public-statuses:host:v1:${origin}`;
const actorAttemptKey = (actorUri: string) => `fedsync:public-statuses:actor:v1:${actorUri}`;

type Get =
  | { kind: 'ok'; body: Buffer }
  | { kind: 'http'; status: number; retryAfter?: string }
  | { kind: 'failed' };

/** One bounded, SSRF-safe GET. Redirects are not followed. */
async function get(url: string, accept: string, maxBytes: number): Promise<Get> {
  try {
    const { response, status, headers } = await safeFetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headersTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (status < 200 || status >= 300) {
      response.destroy();
      const retryAfter = headers['retry-after'];
      return {
        kind: 'http',
        status,
        retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
      };
    }
    const result = await readResponseBody(response, { maxBytes, timeoutMs: REQUEST_TIMEOUT_MS });
    return result.kind === 'ok' ? { kind: 'ok', body: result.body } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

type JsonGet = Exclude<Get, { kind: 'ok' }> | { kind: 'ok'; body: unknown };

async function getJson(url: string): Promise<JsonGet> {
  const answer = await get(url, 'application/json', MAX_JSON_BYTES);
  if (answer.kind !== 'ok') return answer;
  try {
    return { kind: 'ok', body: JSON.parse(answer.body.toString('utf8')) };
  } catch {
    return { kind: 'failed' };
  }
}

/** A `Retry-After` (delta-seconds or HTTP date) as a bounded number of seconds. */
export function retryAfterSeconds(value: string | undefined, nowMs = Date.now()): number {
  let seconds = Number.NaN;
  if (value !== undefined) {
    const trimmed = value.trim();
    seconds = /^\d+$/.test(trimmed)
      ? Number(trimmed)
      : Math.ceil((Date.parse(trimmed) - nowMs) / 1000);
  }
  if (!Number.isFinite(seconds)) seconds = RETRY_AFTER_DEFAULT_SECONDS;
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, seconds));
}

/**
 * Whether robots.txt lets us at {@link ACCOUNT_API_PATH}: the group naming
 * `mention`, else the `*` group, longest matching rule wins, `Allow` on a tie.
 * No robots.txt (or an unreadable one) closes nothing.
 */
export function robotsAllowsAccountApi(robotsTxt: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current && value) {
      current.rules.push({ allow: field === 'allow', path: value.replace(/\*$/, '') });
    }
  }
  const named = groups.filter((group) => group.agents.some((agent) => agent === 'mention'));
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  let verdict: { allow: boolean; path: string } | undefined;
  for (const rule of applicable.flatMap((group) => group.rules)) {
    // Only a rule covering the whole account API decides; a narrower one (a
    // single endpoint) leaves the rest open, and wildcards fail open.
    if (!ACCOUNT_API_PATH.startsWith(rule.path)) continue;
    if (
      !verdict ||
      rule.path.length > verdict.path.length ||
      (rule.path.length === verdict.path.length && rule.allow)
    ) {
      verdict = rule;
    }
  }
  return verdict?.allow ?? true;
}

/** The server's NodeInfo `software.name`, lowercased; null when it publishes none we can read. */
async function serverSoftware(origin: string): Promise<string | null> {
  const index = await getJson(`${origin}/.well-known/nodeinfo`);
  if (index.kind !== 'ok') return null;
  const links = asRecord(index.body)?.links;
  if (!Array.isArray(links)) return null;
  const href = links
    .map(asRecord)
    .find((link) => typeof link?.rel === 'string' && NODEINFO_2_REL.test(link.rel))?.href;
  if (typeof href !== 'string' || !sameOrigin(href, origin)) return null;
  const document = await getJson(href);
  if (document.kind !== 'ok') return null;
  const name = asRecord(asRecord(document.body)?.software)?.name;
  return typeof name === 'string' ? name.trim().toLowerCase() : null;
}

/**
 * Whether the server serves Mastodon's account API and lets us use it: its
 * NodeInfo names Mastodon-compatible software and its robots.txt does not
 * close the account API. `null` when NodeInfo could not be read (cached briefly).
 */
function serverServesAccountApi(origin: string): Promise<boolean | null> {
  return serverCache.getOrCompute(
    serverKey(origin),
    async () => {
      const software = await serverSoftware(origin);
      if (software === null) return null;
      if (!MASTODON_API_SOFTWARE.has(software)) return false;
      const robots = await get(`${origin}/robots.txt`, 'text/plain', MAX_ROBOTS_BYTES);
      return robots.kind === 'ok' ? robotsAllowsAccountApi(robots.body.toString('utf8')) : true;
    },
    {
      ttlSecondsFor: (served) =>
        served === null ? SERVER_FAILURE_TTL_SECONDS : SERVER_TTL_SECONDS,
    },
  );
}

/**
 * Whether an API answer ends the run. A 401/403 (the server wants credentials,
 * or allows only listed domains) or a 429/503 (it wants us to slow down) also
 * backs the host off, so no other actor on it is asked either.
 */
async function stopsRun(origin: string, answer: JsonGet): Promise<boolean> {
  if (answer.kind === 'ok') return false;
  if (answer.kind === 'http') {
    const backoffSeconds =
      answer.status === 401 || answer.status === 403
        ? AUTH_REQUIRED_BACKOFF_SECONDS
        : answer.status === 429 || answer.status === 503
          ? retryAfterSeconds(answer.retryAfter)
          : undefined;
    if (backoffSeconds !== undefined) {
      await throttleCache.set(hostBackoffKey(origin), true, { ttlSeconds: backoffSeconds });
    }
    logger.info('[FedSync] public statuses API stopped', {
      status: answer.status,
      backoffSeconds,
    });
  }
  return true;
}

/** The account's local username on its own server, as Mastodon's lookup takes it. */
function localUsername(actor: { username?: string; acct?: string }): string | undefined {
  const username = actor.username || actor.acct?.split('@')[0];
  return username && /^[A-Za-z0-9_.-]{1,64}$/.test(username) ? username : undefined;
}

/**
 * The canonical ActivityPub URIs of the account's public statuses, newest
 * first, as its Mastodon-compatible server lists them. Replies and boosts are
 * left out: a profile's posts are what fill it, and each reply would also walk
 * its thread across other servers. Yields nothing for any other server, a
 * blocked domain, or an actor discovered within the last
 * {@link ACTOR_ATTEMPT_TTL_SECONDS}. Never throws.
 */
export async function* mastodonPublicStatusUris(actor: {
  uri: string;
  username?: string;
  acct?: string;
}): AsyncGenerator<string> {
  let origin: string;
  try {
    const url = new URL(actor.uri);
    if (url.protocol !== 'https:' || isBlockedDomain(url.hostname.toLowerCase())) return;
    origin = url.origin;
  } catch {
    return;
  }
  const username = localUsername(actor);
  if (!username) return;
  if (await throttleCache.has(hostBackoffKey(origin))) return;
  if (await throttleCache.has(actorAttemptKey(actor.uri))) return;

  if ((await serverServesAccountApi(origin)) !== true) return;
  await throttleCache.set(actorAttemptKey(actor.uri), true);

  const lookup = await getJson(
    `${origin}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`,
  );
  if (await stopsRun(origin, lookup)) return;
  const account = lookup.kind === 'ok' ? asRecord(lookup.body) : null;
  const accountId = account?.id;
  if (typeof accountId !== 'string' || !MASTODON_ID.test(accountId)) return;
  // Newer Mastodon names the account's actor; one that names another is not this profile.
  if (typeof account?.uri === 'string' && account.uri !== actor.uri) return;
  if (account?.statuses_count === 0) return;

  let maxId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE),
      exclude_replies: 'true',
      exclude_reblogs: 'true',
    });
    if (maxId) query.set('max_id', maxId);
    const answer = await getJson(
      `${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?${query}`,
    );
    if (await stopsRun(origin, answer)) return;
    const statuses = answer.kind === 'ok' && Array.isArray(answer.body) ? answer.body : [];
    for (const raw of statuses) {
      const status = asRecord(raw);
      if (!status || status.reblog) continue;
      if (typeof status.visibility !== 'string' || !PUBLIC_VISIBILITIES.has(status.visibility)) {
        continue;
      }
      if (typeof status.uri === 'string' && sameOrigin(status.uri, actor.uri)) yield status.uri;
    }
    const lastId = asRecord(statuses.at(-1))?.id;
    if (statuses.length < PAGE_SIZE || typeof lastId !== 'string' || !MASTODON_ID.test(lastId)) {
      return;
    }
    maxId = lastId;
  }
}
