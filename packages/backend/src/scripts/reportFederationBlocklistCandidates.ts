/**
 * READ-ONLY INTELLIGENCE: turn other instances' PUBLISHED moderation decisions
 * into a reviewable candidate list, crossed against our own federated corpus.
 *
 * THIS SCRIPT NEVER BLOCKS ANYTHING, AND MUST NEVER LEARN HOW TO.
 *   It reads three things (remote blocklists, our actors, our follows) and
 *   writes NOTHING — not to Mongo, not to `FEDERATION_BLOCKED_DOMAINS`, not to
 *   any config. Adopting another instance's moderation wholesale would make
 *   THEIR policy silently OURS, and some published blocklists are contested. The
 *   deliverable is a report a human reads and acts on; the acting is manual, by
 *   design, and the read-only property is enforced by a source-level test
 *   (`__tests__/reportFederationBlocklistCandidates.test.ts`) rather than left to
 *   a comment.
 *
 * WHY THIS EXISTS
 *   `FEDERATION_BLOCKED_DOMAINS` is unset in production, so Mention federates
 *   with everything — which is how a 1,870-post spam/porn thread reached a real
 *   user's feed. Mastodon 4.0+ instances publish their own domain blocks at
 *   `GET /api/v1/instance/domain_blocks`, and eight of the eleven instances in
 *   that thread were already `suspend`ed by two of the three biggest publishers,
 *   with the same published reason. That is a signal worth reading — but reading
 *   it is not the same as obeying it.
 *
 * CORROBORATION IS THE PRODUCT
 *   A domain blocked by ONE source is that instance's opinion. A domain blocked
 *   by several, independently, at the same severity, for the same stated reason,
 *   is a signal. So every candidate carries WHICH DISTINCT SOURCES block it — by
 *   NAME, not merely how many — AT WHAT SEVERITY, and WHAT THEY SAID, never a
 *   single collapsed verdict. The names are the actionable part: an entry in the
 *   committed policy must list the instances that corroborated it, and a count
 *   cannot be transcribed into that field while an empty one would claim the
 *   decision was Mention's alone.
 *     - `suspend` and `silence` are counted SEPARATELY and never merged. They
 *       are different decisions (drop everything vs. hide from public timelines)
 *       and a domain that two sources merely SILENCE is not a suspend candidate.
 *     - `noop` entries (Mastodon's "listed, but no action taken" severity — it
 *       usually pairs with a media/report rejection rather than a block) do NOT
 *       count toward corroboration at all. They are still reported so nothing is
 *       hidden.
 *   {@link DEFAULT_MIN_SOURCES} is the threshold (2), overridable per run, and a
 *   domain below it NEVER appears as a candidate — it is only ever counted in
 *   the summary as `domainsBelowThreshold`.
 *
 * RANKED BY WHAT IT WOULD COST *US*, NOT BY WHO ELSE BLOCKS IT
 *   A domain nobody here interacts with is noise however many others block it;
 *   the domain that was 77% of the spam thread is the whole point. So every
 *   candidate is crossed against our OWN stored federated content and ranked by
 *   that, not by source count. Each candidate reports both sides of the trade:
 *     `actors`   FederatedActor rows we hold from that domain
 *     `posts`    stored posts authored by those actors (see the attribution note
 *                on {@link measurePostFootprint})
 *     `localUsersFollowing` / `remoteActorsFollowed`
 *                LOCAL users who would lose follows, and how many accounts there
 *                they follow. A block that silently cuts a local user's follows
 *                has to be visible BEFORE anyone pulls the trigger.
 *     `localUsersFollowed`
 *                local users who would lose a remote FOLLOWER there.
 *   `blockedLocally` marks a domain our own policy already rejects, so a review
 *   is not spent on decisions that are already made.
 *
 * OBFUSCATED ENTRIES — NOT A CORNER CASE
 *   Mastodon lets an admin publish a block with the domain MASKED (`exa*****.com`)
 *   alongside `digest`, the SHA-256 of the real domain. This is the MAJORITY of
 *   some lists: measured live, `mstdn.social` masks 308 of its 346 entries (89%),
 *   `mastodon.social` 134 of 403, `mastodon.online` 112 of 333. Ignoring masked
 *   entries would quietly throw away half the corroboration and make a
 *   two-source domain look like a one-source opinion.
 *
 *   A masked entry cannot be read, but it CAN be matched by digest against any
 *   domain we can NAME — and we can name two useful sets: the domains we hold
 *   actors from, and the domains any OTHER source published in plain (masking is
 *   a per-instance choice about the same domain, so what one hides another
 *   usually names). Resolved matches join the corroboration normally, flagged
 *   `resolvedFromDigest`. Unresolved ones are counted in the summary and appear
 *   in no candidate, because we cannot name them — a domain nobody names and we
 *   hold nothing from is one we could neither rank nor act on.
 *
 * TRANSPORT
 *   Every poll goes through {@link signedFetch} — the AP connector's own
 *   SSRF-safe transport (URL validated, TCP pinned to the validated IP, bounded
 *   redirects each re-validated, byte-capped, deadline-bounded). No hand-rolled
 *   `fetch`. A source that answers 404/403 simply DOES NOT PUBLISH a blocklist
 *   (`fosstodon.org` and `hachyderm.io` are both 404) — that is an ordinary
 *   outcome, not an error. Only a transport/parse failure counts as failed, and
 *   even that never aborts the run.
 *
 * THE ONE WAY THIS RUN CAN FAIL
 *   If fewer sources publish than the threshold requires, the threshold is
 *   unreachable, EVERY domain falls below it, and the report comes back empty —
 *   which reads exactly like "there is nothing to block". That vacuous result is
 *   the only outcome treated as a failure (`insufficientPublishingSources`).
 *   Individual source failures below that bar are warnings, not failures.
 *
 * ENV
 *   BLOCKLIST_SOURCES              comma-separated source hostnames (default:
 *                                  every instance in
 *                                  `connectors/activitypub/blocklistSourceRegistry`,
 *                                  which also declares who operates each one)
 *   BLOCKLIST_MIN_SOURCES          corroboration threshold (default 2)
 *   BLOCKLIST_SOURCE_TIMEOUT_MS    per-source wall-clock budget (default 15000)
 *   BLOCKLIST_REPORT_LIMIT         candidate rows rendered (default 50)
 *
 * RUN AS A FARGATE ONE-SHOT (read-only — safe to run at any time):
 *   bun packages/backend/dist/src/scripts/reportFederationBlocklistCandidates.js
 *   BLOCKLIST_MIN_SOURCES=3 bun packages/backend/dist/src/scripts/reportFederationBlocklistCandidates.js
 *
 * REVIEW THE FULL REPORT IN PROCESS (every candidate, every published comment):
 *   bun -e "const m=require('./packages/backend/dist/src/scripts/reportFederationBlocklistCandidates');\
 *   const g=require('mongoose');(async()=>{await g.connect(process.env.MONGODB_URI);\
 *   const r=await m.reportFederationBlocklistCandidates();\
 *   console.dir(r,{depth:null});await g.disconnect();})()"
 */

import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { FederatedActor } from '../models/FederatedActor';
import { FederatedFollow } from '../models/FederatedFollow';
import { signedFetch, runWithTimeout } from '../connectors/activitypub/helpers';
import { isBlockedDomain } from '../connectors/activitypub/constants';
import { BLOCKLIST_SOURCE_INSTANCES } from '../connectors/activitypub/blocklistSourceRegistry';
import { getRemoteHost } from '../connectors/shared/url';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, mapWithConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/**
 * How many DISTINCT sources must block a domain before it may be presented as a
 * candidate at all. One source is an opinion; the floor is deliberately not 1
 * and a single-source hit is never rendered as a row.
 *
 * A SOURCE COUNT IS NOT AN OPERATOR COUNT, and this threshold is the weaker of
 * the two on purpose: two sites sharing a moderation team clear it while
 * corroborating nothing. It is a cheap prefilter that keeps a domain nobody
 * blocks twice out of the expensive footprint queries. The decision threshold is
 * applied to OPERATORS, downstream, by
 * `services/federation/BlocklistProposalService` against
 * {@link BLOCKLIST_SOURCE_REGISTRY} — and because a domain's operator count can
 * never exceed its source count, filtering here can never drop something that
 * would have cleared there.
 */
export const DEFAULT_MIN_SOURCES = 2;

/** Per-source wall-clock budget. One slow source never stalls the run. */
const DEFAULT_SOURCE_TIMEOUT_MS = 15_000;

/** Candidate rows rendered into the human-readable table. */
const DEFAULT_REPORT_LIMIT = 50;

/** Mastodon's public blocklist endpoint (4.0+). */
const DOMAIN_BLOCKS_PATH = '/api/v1/instance/domain_blocks';

/** Actor rows read per `_id` page when attributing a domain's posts. */
const ACTOR_PAGE_SIZE = 500;

/** Follow rows read per `_id` page during the single follow-bucketing pass. */
const FOLLOW_PAGE_SIZE = 1_000;

/** Author ids per `Post.countDocuments` `$in` chunk. */
const POST_COUNT_CHUNK_SIZE = 200;

/** Published comments are remote-controlled text; render a bounded prefix only. */
const MAX_COMMENT_LENGTH = 120;

/**
 * A hostname we are willing to treat as a domain: LDH labels only.
 *
 * Applied to every domain a remote source publishes, before it is used in a
 * query, a report row or a log record. A source is an untrusted party and this
 * is the boundary where its strings stop being arbitrary.
 */
const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Mastodon's `DomainBlock` severities.
 *
 * `suspend` drops the domain entirely; `silence` hides it from public timelines
 * but keeps it reachable; `noop` means the domain is LISTED with no blocking
 * action (typically alongside a media/report rejection). They are three
 * different decisions and this module never collapses them into one.
 */
export type BlockSeverity = 'suspend' | 'silence' | 'noop';

const BLOCK_SEVERITIES: ReadonlySet<string> = new Set<BlockSeverity>(['suspend', 'silence', 'noop']);

/** One entry as published by a source, after validation. */
export interface PublishedBlock {
  /** The masked-or-plain domain exactly as published. */
  domain: string;
  /** SHA-256 of the real domain, when the source published one. */
  digest?: string;
  severity: BlockSeverity;
  comment?: string;
  /** The published `domain` was masked (`exa*****.com`) and cannot be read directly. */
  obfuscated: boolean;
}

/** What one source contributed about one domain. */
export interface SourceObservation {
  source: string;
  severity: BlockSeverity;
  comment?: string;
  /** The source published this block MASKED; we recovered the name from its digest. */
  resolvedFromDigest: boolean;
}

/** Why a source contributed nothing. */
export type SourceOutcome = 'published' | 'not-published' | 'failed';

/** One source's poll result. */
export interface SourcePollResult {
  source: string;
  outcome: SourceOutcome;
  /** HTTP status, when we got far enough to see one. */
  status?: number;
  /** Entries accepted after validation. */
  entries: PublishedBlock[];
  /** Entries the source published that failed validation (malformed/unusable domain). */
  rejectedEntries: number;
  /** Short human detail for a `failed` outcome. */
  detail?: string;
}

/** What a block of one domain would cost or save US. */
export interface LocalFootprint {
  /** `FederatedActor` rows we hold from that domain. */
  actors: number;
  /** Actors there we hold but that never resolved to an Oxy user (no posts attributable). */
  actorsWithoutLocalUser: number;
  /** Stored posts authored by those actors. */
  posts: number;
  /** Distinct LOCAL users with an accepted outbound follow to an account there. */
  localUsersFollowing: number;
  /** Distinct accounts there that some local user follows. */
  remoteActorsFollowed: number;
  /** Distinct LOCAL users an account there follows (they would lose a follower). */
  localUsersFollowed: number;
}

/** A domain that cleared the corroboration threshold. */
export interface BlocklistCandidate {
  domain: string;
  /** DISTINCT sources blocking it at a corroborating severity. This is the threshold. */
  sourceCount: number;
  suspendSources: number;
  silenceSources: number;
  /** Sources that LIST the domain but take no action. Never counted toward `sourceCount`. */
  noopSources: number;
  /** Every source's own verdict, unmerged. */
  observations: SourceObservation[];
  footprint: LocalFootprint;
  /** Our own policy already rejects this domain (includes our own domains). */
  blockedLocally: boolean;
}

export interface BlocklistIntelReport {
  minSources: number;
  sources: SourcePollResult[];
  /** Distinct domains named by at least one source at a corroborating severity. */
  domainsObserved: number;
  /** Named domains that did NOT clear the threshold — counted, never listed. */
  domainsBelowThreshold: number;
  /** Masked entries seen, and how many we recovered from their digest. */
  obfuscatedEntries: number;
  obfuscatedResolved: number;
  obfuscatedUnresolved: number;
  /** Cleared the threshold, ranked by local footprint. */
  candidates: BlocklistCandidate[];
}

export interface ReportFederationBlocklistOptions {
  /** Source instance hostnames to poll. */
  sources?: readonly string[];
  /** Corroboration threshold (distinct sources). */
  minSources?: number;
  /** Per-source wall-clock budget. */
  sourceTimeoutMs?: number;
  /** Sources polled in parallel. */
  concurrency?: number;
}

/** The message of an unknown thrown value, without leaking a stack into a field. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Accept a hostname a remote source published, or reject it.
 *
 * Lowercased and stripped of a trailing dot, then held to {@link DOMAIN_PATTERN}.
 * Everything downstream — Mongo queries, report rows, log records — consumes only
 * what passes here.
 */
export function normalizePublishedDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase().replace(/\.$/, '');
  if (cleaned.length === 0 || cleaned.length > 253) return null;
  return DOMAIN_PATTERN.test(cleaned) ? cleaned : null;
}

/** A published comment, bounded and stripped of control characters. */
function normalizeComment(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_COMMENT_LENGTH
    ? `${cleaned.slice(0, MAX_COMMENT_LENGTH)}…`
    : cleaned;
}

/** A published SHA-256 digest, or nothing. */
function normalizeDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(cleaned) ? cleaned : undefined;
}

/**
 * Parse one source's `/api/v1/instance/domain_blocks` payload.
 *
 * Tolerant of what the fediverse actually serves: a non-array payload yields
 * nothing, and an individual malformed entry is DROPPED and counted rather than
 * failing the source — one bad row must not cost us the other 402. A masked
 * domain is kept (with `obfuscated: true`) because its digest may still resolve.
 */
export function parseDomainBlocks(payload: unknown): {
  entries: PublishedBlock[];
  rejected: number;
} {
  if (!Array.isArray(payload)) return { entries: [], rejected: 0 };

  const entries: PublishedBlock[] = [];
  let rejected = 0;

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected += 1;
      continue;
    }
    const record = raw as Record<string, unknown>;

    const severityRaw = typeof record.severity === 'string'
      ? record.severity.trim().toLowerCase()
      : '';
    if (!BLOCK_SEVERITIES.has(severityRaw)) {
      rejected += 1;
      continue;
    }
    const severity = severityRaw as BlockSeverity;

    const digest = normalizeDigest(record.digest);
    const domain = normalizePublishedDomain(record.domain);
    if (domain) {
      entries.push({
        domain,
        digest,
        severity,
        comment: normalizeComment(record.comment),
        obfuscated: false,
      });
      continue;
    }

    // No readable domain. Keep it ONLY when a digest can still identify it;
    // otherwise the entry carries no information we can act on.
    if (typeof record.domain === 'string' && digest) {
      entries.push({
        domain: record.domain.trim().toLowerCase(),
        digest,
        severity,
        comment: normalizeComment(record.comment),
        obfuscated: true,
      });
      continue;
    }
    rejected += 1;
  }

  return { entries, rejected };
}

/**
 * Poll ONE source's published blocklist.
 *
 * Never throws. A 404/403 is `not-published` — `fosstodon.org` and
 * `hachyderm.io` both answer 404 and that is a normal, expected outcome, not a
 * failure. Only a transport error, an unexpected status, or an unparseable body
 * is `failed`, and even then the run carries on with the sources that answered.
 */
export async function pollSource(
  source: string,
  timeoutMs: number,
): Promise<SourcePollResult> {
  const url = `https://${source}${DOMAIN_BLOCKS_PATH}`;

  // The fetch's own rejection is folded into a VALUE before the race, not caught
  // after it: `runWithTimeout` only ABANDONS the loser, so a transport error
  // arriving after the deadline would otherwise surface as an unhandled
  // rejection and take the process down long after this source was written off.
  const settled = await runWithTimeout(
    signedFetch(url, 'application/json').then(
      (response) => ({ ok: true, response }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    ),
    timeoutMs,
  );

  if (!settled) {
    return {
      source,
      outcome: 'failed',
      entries: [],
      rejectedEntries: 0,
      detail: `poll exceeded ${timeoutMs}ms`,
    };
  }

  if (!settled.ok) {
    // Includes the transport's own content-type rejection, whose message names
    // the offending media type — an instance serving an HTML error page here
    // reads as `failed`, never as `not-published`.
    return {
      source,
      outcome: 'failed',
      entries: [],
      rejectedEntries: 0,
      detail: describeError(settled.error),
    };
  }

  const { response } = settled;

  // 404 (endpoint absent — pre-4.0, or a non-Mastodon server) and 403/401
  // (publishing disabled, or the instance requires auth for it) both mean the
  // same thing to us: this instance does not publish a blocklist.
  if (response.status === 404 || response.status === 403 || response.status === 401) {
    return { source, outcome: 'not-published', status: response.status, entries: [], rejectedEntries: 0 };
  }

  if (!response.ok) {
    return {
      source,
      outcome: 'failed',
      status: response.status,
      entries: [],
      rejectedEntries: 0,
      detail: `source answered HTTP ${response.status}`,
    };
  }

  try {
    // `res.json()` is typed `any`; keep it `unknown` and narrow in the parser so
    // no `any` leaks out of this function.
    const payload: unknown = await response.json();
    const { entries, rejected } = parseDomainBlocks(payload);
    return {
      source,
      outcome: 'published',
      status: response.status,
      entries,
      rejectedEntries: rejected,
    };
  } catch (err) {
    return {
      source,
      outcome: 'failed',
      status: response.status,
      entries: [],
      rejectedEntries: 0,
      detail: describeError(err),
    };
  }
}

/** Corroboration for one domain, before it is measured against our corpus. */
interface DomainCorroboration {
  observations: SourceObservation[];
  suspendSources: number;
  silenceSources: number;
  noopSources: number;
}

/** Tally of masked entries seen while building the corroboration map. */
interface ObfuscationTally {
  seen: number;
  resolved: number;
  unresolved: number;
}

/**
 * Fold every source's entries into one domain → observations map.
 *
 * Corroboration counts DISTINCT SOURCES, so a source that somehow lists the same
 * domain twice still contributes one vote. `noop` observations are recorded on
 * the domain but never counted as a blocking source — a domain only ever listed
 * `noop` therefore has a source count of zero and can never become a candidate.
 *
 * `digestIndex` maps SHA-256 → a domain WE hold, which is what lets a masked
 * entry still corroborate. A masked entry that resolves to nothing we hold is
 * counted and dropped: it cannot be named, and a domain we hold nothing from is
 * not a candidate we could rank anyway.
 */
export function buildCorroboration(
  results: readonly SourcePollResult[],
  digestIndex: ReadonlyMap<string, string>,
): { byDomain: Map<string, DomainCorroboration>; obfuscation: ObfuscationTally } {
  // The vote set rides WITH its corroboration rather than in a parallel map, so
  // the two can never be looked up separately and disagree.
  const accumulated = new Map<string, { corroboration: DomainCorroboration; voters: Set<string> }>();
  const obfuscation: ObfuscationTally = { seen: 0, resolved: 0, unresolved: 0 };

  for (const result of results) {
    if (result.outcome !== 'published') continue;

    for (const entry of result.entries) {
      let domain = entry.domain;
      let resolvedFromDigest = false;

      if (entry.obfuscated) {
        obfuscation.seen += 1;
        const recovered = entry.digest ? digestIndex.get(entry.digest) : undefined;
        if (!recovered) {
          obfuscation.unresolved += 1;
          continue;
        }
        obfuscation.resolved += 1;
        domain = recovered;
        resolvedFromDigest = true;
      }

      let entryFor = accumulated.get(domain);
      if (!entryFor) {
        entryFor = {
          corroboration: { observations: [], suspendSources: 0, silenceSources: 0, noopSources: 0 },
          voters: new Set<string>(),
        };
        accumulated.set(domain, entryFor);
      }
      const { corroboration, voters } = entryFor;

      corroboration.observations.push({
        source: result.source,
        severity: entry.severity,
        comment: entry.comment,
        resolvedFromDigest,
      });

      // One vote per source per domain, whatever the source publishes.
      if (voters.has(result.source)) continue;
      voters.add(result.source);

      if (entry.severity === 'suspend') corroboration.suspendSources += 1;
      else if (entry.severity === 'silence') corroboration.silenceSources += 1;
      else corroboration.noopSources += 1;
    }
  }

  const byDomain = new Map<string, DomainCorroboration>();
  for (const [domain, entryFor] of accumulated) {
    byDomain.set(domain, entryFor.corroboration);
  }
  return { byDomain, obfuscation };
}

/**
 * Distinct sources blocking a domain — the value the threshold is applied to.
 *
 * `suspend` + `silence` only: a `noop` listing is explicitly "no action taken"
 * and must not be able to push a domain over the threshold.
 */
export function corroboratingSourceCount(corroboration: DomainCorroboration): number {
  return corroboration.suspendSources + corroboration.silenceSources;
}

/** Every domain we hold actors from, with how many. One aggregation. */
async function loadCorpusDomains(): Promise<Map<string, number>> {
  const rows = await FederatedActor.aggregate<{ _id: string; actors: number }>([
    { $group: { _id: '$domain', actors: { $sum: 1 } } },
  ]);

  const byDomain = new Map<string, number>();
  for (const row of rows) {
    if (typeof row._id !== 'string') continue;
    const domain = row._id.trim().toLowerCase();
    if (domain.length === 0) continue;
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + row.actors);
  }
  return byDomain;
}

/**
 * SHA-256 → domain, over every domain we can NAME. Recovers masked entries.
 *
 * Seeded from two places, and the second one matters more than it looks:
 *  1. every domain WE hold actors from — the only masked entries that could
 *     affect our own ranking;
 *  2. every domain any source named IN PLAIN — because masking is a per-instance
 *     choice about the SAME domain. Measured on the live lists, `mstdn.social`
 *     masks 308 of its 346 entries (89%), so without this its votes are almost
 *     entirely invisible; `mastodon.social` names `poa.st` openly while
 *     `mstdn.social` masks it, and only the cross-seed turns that into a second
 *     corroborating source.
 *
 * Two domains cannot collide here (SHA-256), so the map is unambiguous.
 */
export function buildDigestIndex(domains: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const domain of domains) {
    index.set(createHash('sha256').update(domain).digest('hex'), domain);
  }
  return index;
}

/** Every domain a source published UNMASKED — the cross-seed for {@link buildDigestIndex}. */
export function plainlyNamedDomains(results: readonly SourcePollResult[]): Set<string> {
  const named = new Set<string>();
  for (const result of results) {
    for (const entry of result.entries) {
      if (!entry.obfuscated) named.add(entry.domain);
    }
  }
  return named;
}

/** Follow edges bucketed per domain, from one pass over the collection. */
interface FollowFootprints {
  /** Local users with an accepted OUTBOUND follow to an account on that domain. */
  localUsersFollowing: Map<string, Set<string>>;
  /** Accounts on that domain some local user follows. */
  remoteActorsFollowed: Map<string, Set<string>>;
  /** Local users an account on that domain follows (an INBOUND accepted follow). */
  localUsersFollowed: Map<string, Set<string>>;
}

interface FollowRow {
  _id: mongoose.Types.ObjectId;
  localUserId?: string;
  remoteActorUri?: string;
  direction?: string;
}

function addToBucket(buckets: Map<string, Set<string>>, domain: string, value: string): void {
  const bucket = buckets.get(domain);
  if (bucket) bucket.add(value);
  else buckets.set(domain, new Set([value]));
}

/**
 * Bucket every accepted follow edge by the remote account's host, in ONE paged
 * pass over `FederatedFollow`.
 *
 * Deliberately derived from the follow edge's OWN `remoteActorUri` rather than
 * from a `FederatedActor` join: a follow whose actor row was later pruned is
 * still a follow a local user would LOSE, and under-counting is the one
 * direction this report must not fail in. atproto follows record a DID rather
 * than a URL, so they simply never match a host and are correctly absent.
 */
async function loadFollowFootprints(): Promise<FollowFootprints> {
  const footprints: FollowFootprints = {
    localUsersFollowing: new Map(),
    remoteActorsFollowed: new Map(),
    localUsersFollowed: new Map(),
  };

  let lastId: mongoose.Types.ObjectId | null = null;
  for (;;) {
    const filter: Record<string, unknown> = { status: 'accepted' };
    if (lastId) filter._id = { $gt: lastId };

    const page = await FederatedFollow.find(filter, {
      _id: 1,
      localUserId: 1,
      remoteActorUri: 1,
      direction: 1,
    })
      .sort({ _id: 1 })
      .limit(FOLLOW_PAGE_SIZE)
      .lean<FollowRow[]>();

    if (page.length === 0) break;

    for (const row of page) {
      if (!row.localUserId || !row.remoteActorUri) continue;
      const domain = getRemoteHost(row.remoteActorUri);
      if (!domain) continue;

      if (row.direction === 'outbound') {
        addToBucket(footprints.localUsersFollowing, domain, row.localUserId);
        addToBucket(footprints.remoteActorsFollowed, domain, row.remoteActorUri);
      } else if (row.direction === 'inbound') {
        addToBucket(footprints.localUsersFollowed, domain, row.localUserId);
      }
    }

    lastId = page[page.length - 1]._id;
  }

  return footprints;
}

interface ActorRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string | null;
}

/**
 * Count the stored posts attributable to a domain.
 *
 * ATTRIBUTION: a federated post is stored against the Oxy user its authoring
 * `FederatedActor` resolved to, and there is no instance-domain field on `Post`
 * to count directly. So the count is "posts authored by the actors we hold from
 * that domain" — which is exactly the content a block would stop us serving.
 * Actors that never resolved to an Oxy user contribute no attributable posts and
 * are reported separately as `actorsWithoutLocalUser` rather than silently
 * lowering the number.
 */
async function measurePostFootprint(
  domain: string,
): Promise<{ posts: number; actorsWithoutLocalUser: number }> {
  let posts = 0;
  let actorsWithoutLocalUser = 0;
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: Record<string, unknown> = { domain };
    if (lastId) filter._id = { $gt: lastId };

    const page = await FederatedActor.find(filter, { _id: 1, oxyUserId: 1 })
      .sort({ _id: 1 })
      .limit(ACTOR_PAGE_SIZE)
      .lean<ActorRow[]>();

    if (page.length === 0) break;

    const authorIds: string[] = [];
    for (const actor of page) {
      if (actor.oxyUserId) authorIds.push(actor.oxyUserId);
      else actorsWithoutLocalUser += 1;
    }

    // Author ids are disjoint across chunks (one actor, one Oxy user), so the
    // per-chunk counts sum exactly.
    for (let i = 0; i < authorIds.length; i += POST_COUNT_CHUNK_SIZE) {
      posts += await Post.countDocuments({
        oxyUserId: { $in: authorIds.slice(i, i + POST_COUNT_CHUNK_SIZE) },
      });
    }

    lastId = page[page.length - 1]._id;
  }

  return { posts, actorsWithoutLocalUser };
}

/** Rank by what a block would cost US, and only then by how many others agree. */
function compareCandidates(a: BlocklistCandidate, b: BlocklistCandidate): number {
  return (
    b.footprint.posts - a.footprint.posts
    || b.footprint.actors - a.footprint.actors
    || b.footprint.localUsersFollowing - a.footprint.localUsersFollowing
    || b.sourceCount - a.sourceCount
    || a.domain.localeCompare(b.domain)
  );
}

/**
 * Poll the sources, corroborate, and cross the result against our own corpus.
 *
 * Operates on the models only — the caller owns the Mongo connection lifecycle —
 * so it is unit-testable against mocked models and reusable in process.
 */
export async function reportFederationBlocklistCandidates(
  options: ReportFederationBlocklistOptions = {},
): Promise<BlocklistIntelReport> {
  const sources = [...new Set(
    (options.sources ?? BLOCKLIST_SOURCE_INSTANCES)
      .map((source) => normalizePublishedDomain(source))
      .filter((source): source is string => source !== null),
  )];
  const minSources = Math.max(1, options.minSources ?? DEFAULT_MIN_SOURCES);
  const sourceTimeoutMs = options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const concurrency = Math.min(
    Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    MAX_CONCURRENCY,
  );

  logger.info('[reportFederationBlocklistCandidates] polling sources', {
    sources: sources.length,
    minSources,
  });

  const settled = await mapWithConcurrency(sources, concurrency, (source) =>
    pollSource(source, sourceTimeoutMs));

  const pollResults: SourcePollResult[] = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    // `pollSource` converts its own failures into a value, so a rejected slot is
    // an unexpected throw. One bad source never aborts the run.
    return {
      source: sources[index],
      outcome: 'failed',
      entries: [],
      rejectedEntries: 0,
      detail: describeError(result.reason),
    };
  });

  for (const result of pollResults) {
    if (result.outcome === 'failed') {
      logger.warn('[reportFederationBlocklistCandidates] source poll failed', {
        source: result.source,
        status: result.status,
        detail: result.detail,
      });
    } else {
      logger.info('[reportFederationBlocklistCandidates] source polled', {
        source: result.source,
        outcome: result.outcome,
        status: result.status,
        entries: result.entries.length,
        rejectedEntries: result.rejectedEntries,
      });
    }
  }

  const corpusDomains = await loadCorpusDomains();
  const { byDomain, obfuscation } = buildCorroboration(
    pollResults,
    buildDigestIndex([...corpusDomains.keys(), ...plainlyNamedDomains(pollResults)]),
  );

  const named = [...byDomain.entries()].filter(
    ([, corroboration]) => corroboratingSourceCount(corroboration) > 0,
  );
  const cleared = named.filter(
    ([, corroboration]) => corroboratingSourceCount(corroboration) >= minSources,
  );

  const followFootprints = await loadFollowFootprints();

  const candidates: BlocklistCandidate[] = [];
  for (const [domain, corroboration] of cleared) {
    const actors = corpusDomains.get(domain) ?? 0;
    // Nothing held from that domain means nothing to attribute — skip the query
    // rather than issue one that can only answer zero. Follow edges are read
    // from the bucketed pass, which does NOT depend on an actor row surviving.
    const { posts, actorsWithoutLocalUser } = actors > 0
      ? await measurePostFootprint(domain)
      : { posts: 0, actorsWithoutLocalUser: 0 };

    candidates.push({
      domain,
      sourceCount: corroboratingSourceCount(corroboration),
      suspendSources: corroboration.suspendSources,
      silenceSources: corroboration.silenceSources,
      noopSources: corroboration.noopSources,
      observations: corroboration.observations,
      blockedLocally: isBlockedDomain(domain),
      footprint: {
        actors,
        actorsWithoutLocalUser,
        posts,
        localUsersFollowing: followFootprints.localUsersFollowing.get(domain)?.size ?? 0,
        remoteActorsFollowed: followFootprints.remoteActorsFollowed.get(domain)?.size ?? 0,
        localUsersFollowed: followFootprints.localUsersFollowed.get(domain)?.size ?? 0,
      },
    });
  }

  candidates.sort(compareCandidates);

  return {
    minSources,
    sources: pollResults,
    domainsObserved: named.length,
    domainsBelowThreshold: named.length - cleared.length,
    obfuscatedEntries: obfuscation.seen,
    obfuscatedResolved: obfuscation.resolved,
    obfuscatedUnresolved: obfuscation.unresolved,
    candidates,
  };
}

/**
 * WHICH sources published a given verdict, BY NAME.
 *
 * A count is enough to RANK a candidate and not enough to ACT on one. The
 * committed policy's `corroboratingSources` is a list of instance NAMES, and
 * `suspend×3` cannot be transcribed into it — while leaving it empty makes the
 * transparency page state that the decision was Mention's alone. So a report
 * that only counted its corroboration could not produce a truthful entry, which
 * is why the names are rendered rather than kept for an in-process reader.
 *
 * ONE NAME PER SOURCE, so the cell's arithmetic matches the `SRCS` column: a
 * source that somehow lists the same domain twice at the same severity votes
 * once here too. Sorted, so re-runs diff cleanly.
 *
 * `(masked)` means that source published the block OBFUSCATED and we recovered
 * the domain from its digest. The vote is real and counts identically — but a
 * digest match is only ever as good as the domain list that seeded it, so the
 * reader is told which names were READ and which were RESOLVED. It is marked
 * only when EVERY one of that source's observations at this severity was masked;
 * one plain publication is a name we read directly.
 */
export function corroboratingSourceNames(
  observations: readonly SourceObservation[],
  severity: BlockSeverity,
): string[] {
  const maskedOnly = new Map<string, boolean>();
  for (const observation of observations) {
    if (observation.severity !== severity) continue;
    const prior = maskedOnly.get(observation.source);
    maskedOnly.set(observation.source, (prior ?? true) && observation.resolvedFromDigest);
  }

  return [...maskedOnly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, masked]) => (masked ? `${source}(masked)` : source));
}

/** Who published what, as one compact cell — `suspend[a.example b.example]`. */
function renderSeverityCell(candidate: BlocklistCandidate): string {
  const parts: string[] = [];
  for (const severity of ['suspend', 'silence', 'noop'] as const) {
    const names = corroboratingSourceNames(candidate.observations, severity);
    if (names.length > 0) parts.push(`${severity}[${names.join(' ')}]`);
  }
  return parts.join(' ');
}

/** The distinct published reasons, deduped — three sources usually say one thing. */
function renderComments(candidate: BlocklistCandidate): string {
  const seen = new Set<string>();
  for (const observation of candidate.observations) {
    if (observation.comment) seen.add(observation.comment);
  }
  return [...seen].join(' | ');
}

/**
 * Render the report as aligned text rows.
 *
 * Returned as an array of LINES rather than one blob because each line is logged
 * as its own record: the backend logger caps a single string field, and a fifty
 * row table in one field would be silently truncated exactly where the tail of
 * the ranking lives.
 */
export function renderReportTable(
  report: BlocklistIntelReport,
  limit: number = DEFAULT_REPORT_LIMIT,
): string[] {
  const shown = report.candidates.slice(0, Math.max(0, limit));
  if (shown.length === 0) {
    return [`no domain reached ${report.minSources} corroborating sources`];
  }

  const rows = shown.map((candidate) => ({
    domain: candidate.domain,
    srcs: String(candidate.sourceCount),
    severity: renderSeverityCell(candidate),
    posts: String(candidate.footprint.posts),
    actors: String(candidate.footprint.actors),
    follows: `${candidate.footprint.localUsersFollowing}u/${candidate.footprint.remoteActorsFollowed}a`,
    followers: String(candidate.footprint.localUsersFollowed),
    already: candidate.blockedLocally ? 'yes' : '',
    why: renderComments(candidate),
  }));

  const header = {
    domain: 'DOMAIN',
    srcs: 'SRCS',
    severity: 'WHO BLOCKS IT',
    posts: 'POSTS',
    actors: 'ACTORS',
    follows: 'WE-FOLLOW',
    followers: 'THEY-FOLLOW',
    already: 'BLOCKED',
    why: 'PUBLISHED REASON',
  };

  const columns = Object.keys(header) as (keyof typeof header)[];
  const widths = new Map<string, number>(
    columns.map((column) => [
      column,
      Math.max(header[column].length, ...rows.map((row) => row[column].length)),
    ]),
  );
  const renderRow = (row: Record<string, string>): string =>
    columns.map((column) => row[column].padEnd(widths.get(column) ?? 0)).join('  ').trimEnd();

  const lines = [renderRow(header), ...rows.map(renderRow)];
  if (report.candidates.length > shown.length) {
    lines.push(`… ${report.candidates.length - shown.length} further candidates omitted (raise BLOCKLIST_REPORT_LIMIT)`);
  }
  return lines;
}

/** Parse a strictly-positive integer env value, falling back on absent/invalid input. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Comma-separated source hostnames from the environment, or nothing. */
function parseSources(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    // This script has NO mutating mode: it is read-only by construction, which
    // is why `dryRun` is a literal here rather than an env flag. Kept as a
    // tripwire — the day someone gives it a write path and threads a variable
    // through, the guard immediately starts demanding an explicit confirmation
    // instead of letting a report quietly become an enforcement tool.
    assertAdminMutationAllowed({
      scriptName: 'reportFederationBlocklistCandidates',
      dryRun: true,
    });
    await mongoose.connect(mongoUri, { dbName });
    logger.info('[reportFederationBlocklistCandidates] connected to MongoDB');

    const minSources = parsePositiveInt(process.env.BLOCKLIST_MIN_SOURCES, DEFAULT_MIN_SOURCES);
    const report = await reportFederationBlocklistCandidates({
      sources: parseSources(process.env.BLOCKLIST_SOURCES),
      minSources,
      sourceTimeoutMs: parsePositiveInt(
        process.env.BLOCKLIST_SOURCE_TIMEOUT_MS,
        DEFAULT_SOURCE_TIMEOUT_MS,
      ),
    });

    // The human-readable table: one record per line, so no row is lost to the
    // logger's per-field string cap.
    for (const line of renderReportTable(
      report,
      parsePositiveInt(process.env.BLOCKLIST_REPORT_LIMIT, DEFAULT_REPORT_LIMIT),
    )) {
      logger.info('[reportFederationBlocklistCandidates] candidate', { row: line });
    }

    const publishing = report.sources.filter((source) => source.outcome === 'published').length;
    const withLocalContent = report.candidates.filter(
      (candidate) => candidate.footprint.posts > 0 || candidate.footprint.actors > 0,
    ).length;
    const withLocalFollows = report.candidates.filter(
      (candidate) => candidate.footprint.localUsersFollowing > 0,
    ).length;

    // ONE machine-readable summary record for a Fargate one-shot's log scrape:
    // pino emits exactly one JSON line per call, so the structured context IS
    // the scrapeable line. The per-candidate detail (every source's own verdict
    // and comment) rides on the RETURNED report — see the header docblock.
    logger.info('[reportFederationBlocklistCandidates] summary', {
      minSources: report.minSources,
      sourcesConfigured: report.sources.length,
      sourcesPublishing: publishing,
      sourcesNotPublishing: report.sources.filter((s) => s.outcome === 'not-published').length,
      sourcesFailed: report.sources.filter((s) => s.outcome === 'failed').length,
      domainsObserved: report.domainsObserved,
      domainsBelowThreshold: report.domainsBelowThreshold,
      candidates: report.candidates.length,
      candidatesWithLocalContent: withLocalContent,
      candidatesWithLocalFollows: withLocalFollows,
      candidatesAlreadyBlocked: report.candidates.filter((c) => c.blockedLocally).length,
      postsAtRisk: report.candidates.reduce((sum, c) => sum + c.footprint.posts, 0),
      actorsAtRisk: report.candidates.reduce((sum, c) => sum + c.footprint.actors, 0),
      localFollowsAtRisk: report.candidates.reduce(
        (sum, c) => sum + c.footprint.remoteActorsFollowed,
        0,
      ),
      obfuscatedEntries: report.obfuscatedEntries,
      obfuscatedResolved: report.obfuscatedResolved,
      obfuscatedUnresolved: report.obfuscatedUnresolved,
      durationMs: Date.now() - startedAt,
    });

    // The ONLY failing outcome. With fewer publishing sources than the threshold
    // needs, no domain can ever clear it and the report comes back empty — which
    // reads exactly like "there is nothing to block". A vacuous report must not
    // pass as a clean run.
    assertAdminRunComplete('reportFederationBlocklistCandidates', {
      insufficientPublishingSources: publishing < report.minSources ? 1 : 0,
    });
  } catch (error) {
    logger.error('[reportFederationBlocklistCandidates] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect().catch((disconnectError) => {
      logger.warn(
        '[reportFederationBlocklistCandidates] error during mongoose.disconnect()',
        disconnectError,
      );
    });
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (the Redis client and BullMQ
  // handles pulled in through the federation helpers) keep the event loop alive,
  // so the Fargate one-shot would sit RUNNING forever after the work completed.
  // Mirrors the other federation one-shots.
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[reportFederationBlocklistCandidates] unhandled failure', error);
      process.exit(1);
    });
}

export default reportFederationBlocklistCandidates;
