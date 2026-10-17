import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { PostRecord } from '../db/posts/postRecord';

/**
 * What a cached, already-hydrated page was built FROM, so a later read can tell
 * whether it is still what a fresh hydration would render.
 *
 * The anonymous feed cache keeps the hydrated page (see `anonFeedCache`), and a
 * read of it must not serve a body that was edited, deleted, re-audienced or
 * re-attributed since. Checking that by re-hydrating costs the whole pipeline
 * against Postgres on every cache hit. Instead, while the page is being built,
 * every post record hydration renders from is fingerprinted here; a cache hit
 * loads the current records and compares fingerprints, and any difference sends
 * the read back through full hydration.
 *
 * The fingerprint covers every {@link PostRecord} field EXCEPT what moves without
 * changing what a reader is shown:
 *   - `stats` — counters, bumped by every like and every view (the cached page's
 *     counts were already allowed to age out within the cache TTL);
 *   - `updatedAt` — moved by those same counter writes.
 * Anything else that changes, including a field nobody renders, is a mismatch.
 * That errs toward a fresh hydration, never toward a stale body.
 *
 * Only `PostRecord`'s own fields count. The feed engine hands hydration records
 * carrying ranking extras (`finalScore`, `engagementScore`, `_discovery`, …)
 * that a record loaded by id never has; fingerprinting those made every cached
 * page look edited. {@link RENDERED_FIELDS} is exhaustive over `PostRecord` at
 * compile time, so a field added to the record must be classified here.
 *
 * Authorization is NOT part of this: a fingerprint never grants anything. The
 * cache hit still asks for current content decisions on every read.
 */

/** Whether each {@link PostRecord} field is part of a revision. */
const RENDERED_FIELDS: Record<keyof PostRecord, boolean> = {
  id: true,
  oxyUserId: true,
  authorship: true,
  type: true,
  visibility: true,
  status: true,
  isReply: true,
  hasLinks: true,
  isEdited: true,
  language: true,
  curated: true,
  hashtags: true,
  editHistory: true,
  replyPermission: true,
  reviewReplies: true,
  quotesDisabled: true,
  correctionCount: true,
  lastCorrectedAt: true,
  boostOf: true,
  quoteOf: true,
  parentPostId: true,
  threadId: true,
  scheduledFor: true,
  writtenByOxyUserId: true,
  laneId: true,
  content: true,
  mentions: true,
  metadata: true,
  federation: true,
  postClassification: true,
  location: true,
  createdAt: true,
  stats: false,
  updatedAt: false,
};
const REVISION_FIELDS = (Object.keys(RENDERED_FIELDS) as Array<keyof PostRecord>)
  .filter((field) => RENDERED_FIELDS[field])
  .sort();

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = stable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** The revision of one assembled post record, as far as rendering is concerned. */
export function postRevision(record: object): string {
  const rendered: Record<string, unknown> = {};
  for (const field of REVISION_FIELDS) {
    const value = (record as Partial<PostRecord>)[field];
    if (value !== undefined) rendered[field] = value;
  }
  return createHash('sha256')
    .update(JSON.stringify(stable(rendered)))
    .digest('base64url');
}

export interface HydrationRevisions {
  /** Post id → {@link postRevision} of the record hydration rendered from. */
  revisions: Record<string, string>;
  /**
   * The unrated-material decision every hydration in the capture received, or
   * `undefined` when hydrations disagreed or none asked. A page built under one
   * answer is only reusable under the same answer.
   */
  unratedMaterialAllowed?: boolean;
}

interface Capture {
  revisions: Map<string, string>;
  unrated: boolean | null | undefined;
}

const storage = new AsyncLocalStorage<Capture>();

/** Run `build` and return what every hydration inside it rendered from. */
export async function captureHydrationRevisions<T>(
  build: () => Promise<T>,
): Promise<{ result: T } & HydrationRevisions> {
  const capture: Capture = { revisions: new Map(), unrated: undefined };
  const result = await storage.run(capture, build);
  return {
    result,
    revisions: Object.fromEntries(capture.revisions),
    unratedMaterialAllowed: capture.unrated ?? undefined,
  };
}

/** Called by hydration. A no-op outside {@link captureHydrationRevisions}. */
export function recordHydrationRevisions(
  records: Iterable<{ id: string; record: object }>,
  unratedMaterialAllowed: boolean,
): void {
  const capture = storage.getStore();
  if (!capture) return;
  for (const { id, record } of records) {
    const revision = postRevision(record);
    const earlier = capture.revisions.get(id);
    // Two hydrations in one build read different revisions of the same post, so
    // the page may hold either. Nothing can match that, so the page is never
    // reused without a fresh hydration.
    capture.revisions.set(id, earlier === undefined || earlier === revision ? revision : '');
  }
  capture.unrated =
    capture.unrated === undefined
      ? unratedMaterialAllowed
      : capture.unrated === unratedMaterialAllowed
        ? capture.unrated
        : null;
}
