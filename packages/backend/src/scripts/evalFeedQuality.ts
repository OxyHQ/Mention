/**
 * Offline feed-quality evaluation harness (Phase 7).
 *
 * A READ-ONLY one-shot that recomputes the ENTIRE For You quality pipeline over a
 * candidate set and reports how well it separates junk from good content — so any
 * change to the v5 classifier, the discovery gate, or ranking is MEASURABLE before
 * it ships. It writes NOTHING (no DB writes, no files); the report is printed to
 * stdout via the logger.
 *
 * Candidate set = the labeled set ({@link resolveLabeledPosts}) ∪ a bounded random
 * federated sample ∪ (optionally, for `--viewer`) a real `gatherForYouCandidates`
 * pool. For every candidate it recomputes, from scratch:
 *   - `baselineContentClassifier.classify(...)` — exercises the v5 ruleset WITHOUT
 *     needing the corpus backfill (the freshly-computed scores are stamped at the
 *     current baseline version, so they read as trusted),
 *   - the discovery-gate predicates (the exact For You gate modules),
 *   - `feedRankingService.calculatePostScore(...)` + `explainRanking(...)`.
 *
 * Reported metrics:
 *   - JUNK-IN-TOP-K (primary) — pre-gate vs post-gate, the fraction of the top K
 *     ranked posts that are labeled junk,
 *   - gate precision / recall vs the labels,
 *   - trusted-quality distribution (p10/p50/p90), junk vs good,
 *   - language-match rate,
 *   - federated share.
 *
 * The core is the exported PURE {@link runFeedQualityEval}: models + services are
 * injected so it is unit-testable with mocks. `main()` does the Mongo/Oxy wiring.
 *
 * Runnable as a Fargate one-shot (do NOT run it as part of normal deploys):
 *   bun packages/backend/dist/src/scripts/evalFeedQuality.js --viewer <oxyId> --top-k 20
 *   bun packages/backend/dist/src/scripts/evalFeedQuality.js --languages en,es --sample 300
 */

import type { PostClassification, PostContent } from '@mention/shared-types';
import { resolveVariant } from '../services/postVariants';
import type { FeedTuning } from '@mention/shared-types';
import { getBaseLanguage } from '@oxyhq/core';
import { explainRanking } from '../mtn/feed/RankingExplainer';
import { readTrustedScores } from '../services/contentClassification/trustedScores';
import {
  buildBehaviorSets,
  type RankablePost,
  type RankingUserBehavior,
} from '../services/ranking/signalContext';
import type { BaselineContentClassifier, ClassifyInput } from '../services/BaselineContentClassifier';
import type { FeedRankingService } from '../services/FeedRankingService';
import type { CandidatePost, FeedEngineContext, DiscoveryGateBucket } from '../mtn/feed/engine/types';
import type { InteractionEvent } from '../mtn/feed/FeedInteractionTracker';
import { originForFederation } from '../mtn/feed/feedMetrics';
import type {
  FeedQualityLabel,
  LabeledActor,
  LabeledPost,
  LabelResolverDeps,
} from './fixtures/feedQualityLabels';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Where a candidate came from — for reporting, not scoring. */
export type EvalCandidateSource = 'labeled' | 'random' | 'forYou';

/** One post to evaluate, plus its label (if any) and federated-actor context. */
export interface EvalCandidate {
  post: CandidatePost;
  source: EvalCandidateSource;
  label?: FeedQualityLabel;
  reason?: string;
  /** The labeled account handle (`user@host`), when this is an account-level labeled post. */
  acct?: string;
  actor?: LabeledActor;
}

/** A discovery-gate filter to evaluate, in application order (the exact For You gate). */
export interface EvalGateModule {
  id: string;
  keep: (post: CandidatePost, ctx: FeedEngineContext, params: Record<string, unknown>) => boolean;
  params: Record<string, unknown>;
}

/** Viewer/session context for the gate predicates and ranking. */
export interface EvalContext {
  userBehavior?: RankingUserBehavior;
  /** The viewer's account languages — BCP-47 locales (`es-ES`) or bare base subtags (`es`). */
  viewerLanguages?: string[];
  feedTuning?: FeedTuning;
  followingIds?: string[];
  /** Opt-in ranking signal ids to enable (the For You Phase-2b/4 set). */
  enabledSignals?: Set<string>;
}

export interface FeedQualityEvalDeps {
  candidates: EvalCandidate[];
  classifier: Pick<BaselineContentClassifier, 'classify'>;
  ranking: Pick<FeedRankingService, 'calculatePostScore'>;
  gateModules: EvalGateModule[];
  context: EvalContext;
  /** Viewer oxy id for `calculatePostScore`; undefined ⇒ anonymous. */
  viewerId?: string;
  topK: number;
}

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
  n: number;
}

/** Per-candidate evaluated row (sorted by score, descending, in the report). */
export interface EvalScoredRow {
  id: string;
  source: EvalCandidateSource;
  label?: FeedQualityLabel;
  acct?: string;
  federated: boolean;
  score: number;
  gated: boolean;
  gateReason?: string;
  quality: number | null;
  languages: string[];
  topReason: string;
}

export interface EvalReport {
  totalCandidates: number;
  federatedShare: number;
  labeled: { junk: number; good: number };
  topK: number;
  /** Junk fraction of the top K ranked over the FULL candidate set (no gate). */
  junkInTopKPreGate: { count: number; window: number; rate: number };
  /** Junk fraction of the top K ranked over the GATE-SURVIVING set. */
  junkInTopK: { count: number; window: number; rate: number };
  gate: {
    labeledJunk: number;
    labeledGood: number;
    rejectedJunk: number;
    rejectedGood: number;
    /** rejectedJunk / (rejectedJunk + rejectedGood); null when nothing rejected. */
    precision: number | null;
    /** rejectedJunk / labeledJunk; null when there is no labeled junk. */
    recall: number | null;
    /** reason (rejecting filter id) → count, over ALL candidates. */
    reasons: Record<string, number>;
  };
  quality: {
    all: Percentiles;
    junk: Percentiles;
    good: Percentiles;
    trustedCount: number;
  };
  /** Fraction of language-declaring candidates that overlap the viewer languages; null when unknown. */
  languageMatchRate: number | null;
  rows: EvalScoredRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Field readers — mirror the engine's `field` helper (lean docs are not statically
// typed for every field the pipeline reads).
// ─────────────────────────────────────────────────────────────────────────────

function field<T = unknown>(post: CandidatePost, key: string): T | undefined {
  return (post as Record<string, unknown>)[key] as T | undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readText(post: CandidatePost): string {
  const content = field<PostContent>(post, 'content');
  return content ? resolveVariant(content).text : '';
}

function readClassificationLanguages(post: CandidatePost): string[] {
  return readStringArray(post.postClassification?.languages);
}

/** The federated actor uri of a post, when present. */
export function federationActorUri(post: CandidatePost): string | undefined {
  const federation = field<{ actorUri?: unknown }>(post, 'federation');
  return typeof federation?.actorUri === 'string' && federation.actorUri.length > 0
    ? federation.actorUri
    : undefined;
}

/** The lowercase host of a URI, or `undefined` when it is not parseable. */
function hostOf(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const match = /^https?:\/\/([^/:?#\s]+)/i.exec(uri);
  return match ? match[1].toLowerCase() : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build the classifier input for a candidate from its post + federated-actor context. */
export function buildClassifyInput(candidate: EvalCandidate): ClassifyInput {
  const post = candidate.post;
  const isFederated = originForFederation(post.federation) === 'federated';
  return {
    text: readText(post),
    hashtags: readStringArray(post.hashtags),
    language: readString(field(post, 'language')),
    languages: readClassificationLanguages(post),
    isFederated,
    instanceDomain: candidate.actor?.domain ?? hostOf(federationActorUri(post)),
    actorType: candidate.actor?.type,
  };
}

/**
 * Produce a candidate with the FRESHLY-computed v5 classification stamped on
 * (scores/languages/topics/sensitive at the current baseline version, so they read
 * as trusted), preserving every other field. Federated posts are marked
 * `_discovery` so the discovery-scoped ranking signals (language-mismatch penalty,
 * local boost) apply exactly as they would for a real discovery candidate.
 */
export function withClassification(
  post: CandidatePost,
  signals: ReturnType<BaselineContentClassifier['classify']>,
): CandidatePost {
  const existing = post.postClassification ?? {};
  const classification: Partial<PostClassification> & { topics?: string[] } = {
    ...existing,
    status: 'baseline',
    version: signals.version,
    scores: signals.scores,
    languages: signals.languages,
    topics: signals.topics,
    sensitive: signals.sensitive,
  };
  return {
    ...post,
    postClassification: classification,
    _discovery: originForFederation(post.federation) === 'federated' || post._discovery === true,
  };
}

/** Evaluate the gate modules in order; the first rejecting module is the reason. */
export function evaluateGate(
  post: CandidatePost,
  ctx: FeedEngineContext,
  gateModules: EvalGateModule[],
): { passed: boolean; reason?: string } {
  for (const module of gateModules) {
    if (!module.keep(post, ctx, module.params)) {
      return { passed: false, reason: module.id };
    }
  }
  return { passed: true };
}

/** Nearest-rank p10/p50/p90 over a numeric sample (empty ⇒ all zeros). */
export function percentiles(values: number[]): Percentiles {
  const n = values.length;
  if (n === 0) return { p10: 0, p50: 0, p90: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return { p10: at(10), p50: at(50), p90: at(90), n };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute the feed-quality pipeline over the candidate set and produce the
 * {@link EvalReport}. PURE: every dependency is injected, so this runs identically
 * with real models/services or in-memory mocks (the unit test).
 */
export async function runFeedQualityEval(deps: FeedQualityEvalDeps): Promise<EvalReport> {
  const { candidates, classifier, ranking, gateModules, context, viewerId, topK } = deps;

  const gateCtx: FeedEngineContext = {
    currentUserId: viewerId,
    followingIds: context.followingIds ?? [],
    userBehavior: context.userBehavior,
    feedTuning: context.feedTuning,
    viewerLanguages: context.viewerLanguages,
  };

  // Built once (not per post) — the negative-penalty + personalization signals read it.
  const behaviorSets = buildBehaviorSets(context.userBehavior);
  // The language-match METRIC mirrors the `languageMismatchPenalty` signal: the
  // viewer's BCP-47 locales are reduced to their base subtag (`es-ES` → `es`) so
  // they compare like-for-like against a post's ISO 639-1 classification languages.
  const viewerLangSet = new Set(
    (context.viewerLanguages ?? []).map((locale) => getBaseLanguage(locale)).filter((base) => base.length > 0),
  );

  const rows: EvalScoredRow[] = [];

  for (const candidate of candidates) {
    const signals = classifier.classify(buildClassifyInput(candidate));
    const evaluated = withClassification(candidate.post, signals);

    const gateResult = evaluateGate(evaluated, gateCtx, gateModules);

    // calculatePostScore attaches the `_rank*` breakdown in place; explainRanking reads it.
    const score = await ranking.calculatePostScore(evaluated as RankablePost, viewerId, {
      userBehavior: context.userBehavior,
      behaviorSets,
      followingIds: context.followingIds,
      viewerLanguages: context.viewerLanguages,
      enabledSignals: context.enabledSignals,
    });
    const explanation = explainRanking(evaluated as RankablePost);

    const trusted = readTrustedScores(evaluated);
    rows.push({
      id: String(candidate.post._id),
      source: candidate.source,
      label: candidate.label,
      acct: candidate.acct,
      federated: originForFederation(candidate.post.federation) === 'federated',
      score,
      gated: !gateResult.passed,
      gateReason: gateResult.reason,
      quality: trusted ? trusted.quality : null,
      languages: signals.languages,
      topReason: explanation.topReason,
    });
  }

  return buildReport(rows, topK, viewerLangSet);
}

/** Aggregate per-candidate rows into the report. Pure. */
function buildReport(
  rows: EvalScoredRow[],
  topK: number,
  viewerLangSet: Set<string>,
): EvalReport {
  const total = rows.length;
  const byScoreDesc = [...rows].sort((a, b) => b.score - a.score);

  const junkRows = rows.filter((r) => r.label === 'junk');
  const goodRows = rows.filter((r) => r.label === 'good');

  // Junk-in-top-K, pre-gate (full set) and post-gate (survivors).
  const preWindow = Math.min(topK, byScoreDesc.length);
  const preTop = byScoreDesc.slice(0, preWindow);
  const preJunk = preTop.filter((r) => r.label === 'junk').length;

  const survivors = byScoreDesc.filter((r) => !r.gated);
  const postWindow = Math.min(topK, survivors.length);
  const postTop = survivors.slice(0, postWindow);
  const postJunk = postTop.filter((r) => r.label === 'junk').length;

  // Gate precision/recall over LABELED posts.
  const rejectedJunk = junkRows.filter((r) => r.gated).length;
  const rejectedGood = goodRows.filter((r) => r.gated).length;
  const totalRejected = rejectedJunk + rejectedGood;
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.gated && r.gateReason) reasons[r.gateReason] = (reasons[r.gateReason] ?? 0) + 1;
  }

  // Trusted-quality distributions.
  const withQuality = (rs: EvalScoredRow[]): number[] =>
    rs.filter((r): r is EvalScoredRow & { quality: number } => r.quality !== null).map((r) => r.quality);
  const trustedAllQ = withQuality(rows);

  // Language-match rate over candidates that declare a language (null if viewer
  // unknown). `viewerLangSet` already holds BASE subtags, so the post's languages
  // are reduced the same way before the lookup.
  let languageMatchRate: number | null = null;
  if (viewerLangSet.size > 0) {
    const withLang = rows.filter((r) => r.languages.length > 0);
    const matched = withLang.filter((r) => r.languages.some((l) => viewerLangSet.has(getBaseLanguage(l)))).length;
    languageMatchRate = ratio(matched, withLang.length);
  }

  const federatedCount = rows.filter((r) => r.federated).length;

  return {
    totalCandidates: total,
    federatedShare: ratio(federatedCount, total),
    labeled: { junk: junkRows.length, good: goodRows.length },
    topK,
    junkInTopKPreGate: { count: preJunk, window: preWindow, rate: ratio(preJunk, preWindow) },
    junkInTopK: { count: postJunk, window: postWindow, rate: ratio(postJunk, postWindow) },
    gate: {
      labeledJunk: junkRows.length,
      labeledGood: goodRows.length,
      rejectedJunk,
      rejectedGood,
      precision: totalRejected > 0 ? rejectedJunk / totalRejected : null,
      recall: junkRows.length > 0 ? rejectedJunk / junkRows.length : null,
      reasons,
    },
    quality: {
      all: percentiles(trustedAllQ),
      junk: percentiles(withQuality(junkRows)),
      good: percentiles(withQuality(goodRows)),
      trustedCount: trustedAllQ.length,
    },
    languageMatchRate,
    rows: byScoreDesc,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Online mode — engagement-per-impression + report-rate from FeedInteraction.
//
// The `FeedInteraction` collection (90-day TTL) already records every impression /
// click / like / reply / boost / save / report, so engagement-per-impression and
// report-per-impression are derivable at query time — no background aggregator is
// needed. Split by the deterministic A/B bucket (recomputed from `userId`), this is
// the online comparison the discovery-gate experiment is validated on.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-event interaction counts (a subset of the {@link InteractionEvent} space). */
export type OnlineEventCounts = Partial<Record<InteractionEvent, number>>;

/** One pre-aggregated `(userId, event) → count` row from the interaction collection. */
export interface OnlineInteractionRow {
  userId: string;
  event: InteractionEvent;
  count: number;
}

export interface OnlineEngagementReport {
  impressions: number;
  engagements: number;
  reports: number;
  engagementPerImpression: number;
  reportPerImpression: number;
}

/** Events that count as POSITIVE engagement in the per-impression ratio. */
const ENGAGEMENT_EVENTS: InteractionEvent[] = ['click', 'like', 'reply', 'boost', 'save'];

/** Compute engagement-per-impression and report-per-impression from event counts. Pure. */
export function computeOnlineEngagement(counts: OnlineEventCounts): OnlineEngagementReport {
  const impressions = counts.impression ?? 0;
  const engagements = ENGAGEMENT_EVENTS.reduce((sum, event) => sum + (counts[event] ?? 0), 0);
  const reports = counts.report ?? 0;
  return {
    impressions,
    engagements,
    reports,
    engagementPerImpression: impressions > 0 ? engagements / impressions : 0,
    reportPerImpression: impressions > 0 ? reports / impressions : 0,
  };
}

/**
 * Aggregate `(userId, event, count)` rows into an overall + per-A/B-bucket
 * engagement report, bucketing each user via the injected `bucketOf`. Pure, so the
 * A/B split is exercised deterministically in tests.
 */
export function aggregateOnlineByBucket(
  rows: OnlineInteractionRow[],
  bucketOf: (userId: string) => DiscoveryGateBucket | 'none',
): { overall: OnlineEngagementReport; byBucket: Record<string, OnlineEngagementReport> } {
  const overallCounts: OnlineEventCounts = {};
  const bucketCounts = new Map<string, OnlineEventCounts>();

  for (const row of rows) {
    overallCounts[row.event] = (overallCounts[row.event] ?? 0) + row.count;
    const bucket = bucketOf(row.userId);
    const counts = bucketCounts.get(bucket) ?? {};
    counts[row.event] = (counts[row.event] ?? 0) + row.count;
    bucketCounts.set(bucket, counts);
  }

  const byBucket: Record<string, OnlineEngagementReport> = {};
  for (const [bucket, counts] of bucketCounts) byBucket[bucket] = computeOnlineEngagement(counts);
  return { overall: computeOnlineEngagement(overallCounts), byBucket };
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate assembly (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Merge labeled + random + For You posts into a deduped candidate set (labeled wins). */
export function assembleCandidates(
  labeledPosts: LabeledPost<CandidatePost>[],
  randomSample: CandidatePost[],
  forYouPool: CandidatePost[],
  actorByUri: Map<string, LabeledActor>,
): EvalCandidate[] {
  const byId = new Map<string, EvalCandidate>();

  for (const labeled of labeledPosts) {
    const id = String(labeled.post._id);
    if (!id) continue;
    byId.set(id, {
      post: labeled.post,
      source: 'labeled',
      label: labeled.label,
      reason: labeled.reason,
      acct: labeled.acct,
      actor: labeled.actor,
    });
  }

  const addUnlabeled = (post: CandidatePost, source: EvalCandidateSource): void => {
    const id = String(post._id);
    if (!id || byId.has(id)) return; // labeled (or an earlier source) wins
    const actorUri = federationActorUri(post);
    byId.set(id, { post, source, actor: actorUri ? actorByUri.get(actorUri) : undefined });
  };

  for (const post of randomSample) addUnlabeled(post, 'random');
  for (const post of forYouPool) addUnlabeled(post, 'forYou');

  return Array.from(byId.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting (stdout via logger — no file writes)
// ─────────────────────────────────────────────────────────────────────────────

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function fmtPct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatReportLines(report: EvalReport): string[] {
  const lines: string[] = [];
  lines.push('──────────────────────────────────────────────────────────────');
  lines.push('  FEED QUALITY EVAL');
  lines.push('──────────────────────────────────────────────────────────────');
  lines.push(`  candidates: ${report.totalCandidates}  (labeled junk=${report.labeled.junk}, good=${report.labeled.good})`);
  lines.push(`  federated share: ${fmtPct(report.federatedShare)}`);
  lines.push('');
  lines.push(`  JUNK-IN-TOP-${report.topK} (primary):`);
  lines.push(`    pre-gate : ${report.junkInTopKPreGate.count}/${report.junkInTopKPreGate.window}  (${fmtPct(report.junkInTopKPreGate.rate)})`);
  lines.push(`    post-gate: ${report.junkInTopK.count}/${report.junkInTopK.window}  (${fmtPct(report.junkInTopK.rate)})`);
  lines.push('');
  lines.push('  DISCOVERY GATE (vs labels):');
  lines.push(`    precision: ${fmtPct(report.gate.precision)}   recall: ${fmtPct(report.gate.recall)}`);
  lines.push(`    rejected junk=${report.gate.rejectedJunk}/${report.gate.labeledJunk}, good=${report.gate.rejectedGood}/${report.gate.labeledGood}`);
  const reasonLine = Object.entries(report.gate.reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  lines.push(`    reasons: ${reasonLine || '(none)'}`);
  lines.push('');
  lines.push(`  TRUSTED QUALITY (p10/p50/p90, n=${report.quality.trustedCount}):`);
  lines.push(`    all : ${fmt(report.quality.all.p10)}/${fmt(report.quality.all.p50)}/${fmt(report.quality.all.p90)} (n=${report.quality.all.n})`);
  lines.push(`    junk: ${fmt(report.quality.junk.p10)}/${fmt(report.quality.junk.p50)}/${fmt(report.quality.junk.p90)} (n=${report.quality.junk.n})`);
  lines.push(`    good: ${fmt(report.quality.good.p10)}/${fmt(report.quality.good.p50)}/${fmt(report.quality.good.p90)} (n=${report.quality.good.n})`);
  lines.push('');
  lines.push(`  language-match rate: ${fmtPct(report.languageMatchRate)}`);
  lines.push('');
  lines.push('  LABELED SAMPLE (score / gated / quality / langs):');
  for (const row of report.rows.filter((r) => r.label)) {
    const gate = row.gated ? `GATED(${row.gateReason})` : 'kept';
    const quality = row.quality === null ? 'n/a' : fmt(row.quality, 2);
    lines.push(`    [${row.label}] ${row.acct ?? row.id}  score=${fmt(row.score, 4)}  ${gate}  q=${quality}  langs=[${row.languages.join(',')}]`);
  }
  lines.push('──────────────────────────────────────────────────────────────');
  return lines;
}

export function formatOnlineLines(
  online: { overall: OnlineEngagementReport; byBucket: Record<string, OnlineEngagementReport> },
  windowMs: number,
): string[] {
  const lines: string[] = [];
  const row = (label: string, r: OnlineEngagementReport): string =>
    `    ${label.padEnd(9)} impressions=${r.impressions}  eng/imp=${fmt(r.engagementPerImpression, 4)}  report/imp=${fmt(r.reportPerImpression, 5)}`;
  lines.push('');
  lines.push(`  ONLINE (FeedInteraction, last ${Math.round(windowMs / (24 * 60 * 60 * 1000))}d):`);
  lines.push(row('overall', online.overall));
  for (const [bucket, report] of Object.entries(online.byBucket).sort()) {
    lines.push(row(bucket, report));
  }
  lines.push('──────────────────────────────────────────────────────────────');
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mongo / Oxy wiring (main only)
// ─────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  topK: number;
  viewerId?: string;
  sampleSize: number;
  languages: string[];
  online: boolean;
  onlineWindowMs: number;
}

const DEFAULT_ONLINE_WINDOW_DAYS = 7;

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const eqPrefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(eqPrefix));
    if (hit) return hit.slice(eqPrefix.length);
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')
      ? argv[idx + 1]
      : undefined;
  };
  const topK = Number.parseInt(get('top-k') ?? '', 10);
  const sample = Number.parseInt(get('sample') ?? '', 10);
  const windowDays = Number.parseInt(get('online-window-days') ?? '', 10);
  const languages = (get('languages') ?? '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0);
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : DEFAULT_ONLINE_WINDOW_DAYS;
  return {
    topK: Number.isFinite(topK) && topK > 0 ? topK : 20,
    viewerId: get('viewer'),
    sampleSize: Number.isFinite(sample) && sample > 0 ? sample : 200,
    languages,
    online: argv.includes('--online'),
    onlineWindowMs: days * 24 * 60 * 60 * 1000,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));

  // Imports local to main() keep the pure core free of heavy runtime coupling.
  const mongoose = (await import('mongoose')).default;
  const { logger } = await import('../utils/logger');
  const { MtnConfig } = await import('@mention/shared-types');
  const { Post } = await import('../models/Post');
  const FederatedActor = (await import('../models/FederatedActor')).default;
  const { FEED_FIELDS } = await import('../mtn/feed/FeedAPI');
  const { baselineContentClassifier } = await import('../services/BaselineContentClassifier');
  const { feedRankingService } = await import('../services/FeedRankingService');
  const { registerAllModules } = await import('../mtn/feed/engine');
  const { feedModuleRegistry } = await import('../mtn/feed/engine/FeedModuleRegistry');
  const { resolveDiscoveryGate, resolvePhase2bSignals } = await import('../mtn/feed/definitions/presets');
  const { loadViewerFeedContext } = await import('../mtn/feed/feedContext');
  const { gatherForYouCandidates } = await import('../mtn/feed/feeds/forYouCandidateSources');
  const { getServiceOxyClient } = await import('../utils/oxyHelpers');
  const { FEED_QUALITY_LABELS, resolveLabeledPosts } = await import('./fixtures/feedQualityLabels');

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[evalFeedQuality] connected to MongoDB (${dbName})`);

    registerAllModules();

    // Build the exact For You discovery-gate modules from the registry.
    const gateModules: EvalGateModule[] = [];
    for (const ref of resolveDiscoveryGate()) {
      const filter = feedModuleRegistry.getFilter(ref.module);
      if (filter?.keep) {
        gateModules.push({ id: ref.module, keep: filter.keep, params: ref.params ?? {} });
      }
    }

    const toActor = (doc: {
      uri: string; acct: string; domain: string; type: string; oxyUserId?: string;
    }): LabeledActor => ({
      uri: doc.uri, acct: doc.acct, domain: doc.domain, type: doc.type, oxyUserId: doc.oxyUserId,
    });

    // ---- Labeled set (acct → FederatedActor → recent posts) ----
    const labelDeps: LabelResolverDeps<CandidatePost> = {
      async findActorByAcct(acct) {
        const doc = await FederatedActor.findOne({ acct }).lean();
        return doc ? toActor(doc) : null;
      },
      async findActorByUri(uri) {
        const doc = await FederatedActor.findOne({ uri }).lean();
        return doc ? toActor(doc) : null;
      },
      async findRecentPostsForActor(actor, limit) {
        const or: Record<string, unknown>[] = [{ 'federation.actorUri': actor.uri }];
        if (actor.oxyUserId) or.push({ oxyUserId: actor.oxyUserId });
        return Post.find({ $or: or, visibility: 'public', status: 'published' })
          .select(FEED_FIELDS)
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean<CandidatePost[]>();
      },
      async findPostById(postId) {
        if (!mongoose.isValidObjectId(postId)) return null;
        return Post.findOne({ _id: postId }).select(FEED_FIELDS).lean<CandidatePost | null>();
      },
      async findPostByActivityId(activityId) {
        return Post.findOne({ 'federation.activityId': activityId }).select(FEED_FIELDS).lean<CandidatePost | null>();
      },
      actorUriOf: (post) => federationActorUri(post),
    };
    const labeledPosts = await resolveLabeledPosts(FEED_QUALITY_LABELS, labelDeps);
    logger.info(`[evalFeedQuality] resolved ${labeledPosts.length} labeled posts`);

    // ---- Bounded random federated sample ----
    const randomSample = await Post.aggregate<CandidatePost>([
      { $match: { federation: { $ne: null }, visibility: 'public', status: 'published' } },
      { $sample: { size: args.sampleSize } },
    ]);
    logger.info(`[evalFeedQuality] drew ${randomSample.length} random federated posts`);

    // ---- Optional real For You pool for --viewer ----
    let forYouPool: CandidatePost[] = [];
    let viewerContext: Awaited<ReturnType<typeof loadViewerFeedContext>> | undefined;
    if (args.viewerId) {
      viewerContext = await loadViewerFeedContext(args.viewerId, getServiceOxyClient());
      forYouPool = await gatherForYouCandidates({
        viewerId: args.viewerId,
        followingIds: viewerContext.followingIds ?? [],
        subscribedListMemberIds: viewerContext.subscribedListMemberIds,
        userBehavior: viewerContext.userBehavior,
        viewerRegion: viewerContext.viewerRegion,
        seenPostIds: [],
      });
      logger.info(`[evalFeedQuality] gathered ${forYouPool.length} For You candidates for viewer ${args.viewerId}`);
    }

    // ---- Resolve federated-actor context for the unlabeled candidates (batch) ----
    const unlabeled = [...randomSample, ...forYouPool];
    const actorUris = Array.from(
      new Set(
        unlabeled.map((p) => federationActorUri(p)).filter((u): u is string => typeof u === 'string'),
      ),
    );
    const actorByUri = new Map<string, LabeledActor>();
    if (actorUris.length > 0) {
      const actors = await FederatedActor.find({ uri: { $in: actorUris } })
        .select({ uri: 1, acct: 1, domain: 1, type: 1, oxyUserId: 1 })
        .lean();
      for (const a of actors) actorByUri.set(a.uri, toActor(a));
    }

    // ---- Assemble the candidate set (dedup by _id, labeled wins) ----
    const candidates = assembleCandidates(labeledPosts, randomSample, forYouPool, actorByUri);

    // ---- Viewer languages: CLI override, else the viewer's resolved Oxy account locales ----
    const viewerLanguages = args.languages.length > 0
      ? args.languages
      : (viewerContext?.viewerLanguages ?? []);

    const enabledSignals = new Set(resolvePhase2bSignals().map((ref) => ref.module));

    const report = await runFeedQualityEval({
      candidates,
      classifier: baselineContentClassifier,
      ranking: feedRankingService,
      gateModules,
      context: {
        userBehavior: viewerContext?.userBehavior,
        viewerLanguages,
        feedTuning: viewerContext?.feedTuning,
        followingIds: viewerContext?.followingIds,
        enabledSignals,
      },
      viewerId: args.viewerId,
      topK: args.topK,
    });

    // Master switch echoed so the report is self-describing about gate mode.
    logger.info(`[evalFeedQuality] gate: enabled=${MtnConfig.feed.discoveryGate.enabled} shadow=${MtnConfig.feed.discoveryGate.shadow} modules=[${gateModules.map((m) => m.id).join(',')}]`);
    for (const line of formatReportLines(report)) logger.info(line);

    // ---- Online mode: engagement-per-impression + report-rate from FeedInteraction ----
    if (args.online) {
      const { FeedInteraction } = await import('../models/FeedInteraction');
      const { resolveDiscoveryGateBucket } = await import('../mtn/feed/discoveryGateExperiment');
      const since = new Date(Date.now() - args.onlineWindowMs);
      const grouped = await FeedInteraction.aggregate<OnlineInteractionRow>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { userId: '$userId', event: '$event' }, count: { $sum: 1 } } },
        { $project: { _id: 0, userId: '$_id.userId', event: '$_id.event', count: 1 } },
      ]);
      const online = aggregateOnlineByBucket(grouped, (userId) => resolveDiscoveryGateBucket(userId) ?? 'none');
      for (const line of formatOnlineLines(online, args.onlineWindowMs)) logger.info(line);
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    logger.info(`[evalFeedQuality] done in ${elapsed}s`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    const { logger } = await import('../utils/logger');
    logger.error('[evalFeedQuality] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
