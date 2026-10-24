import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { ContentAccessInput, SafetyDecision, SafetyRequester } from '@oxy.so/contracts';
import { getServiceOxyClient } from '../utils/oxyHelpers';

/**
 * Request-scoped content decisions (oxy ADR 0041).
 *
 * Every hydration asks Oxy's `content-access-batch` for the posts it is about to
 * show, and one HTTP request can hydrate several times (a post and its replies,
 * a feed page and its peek, a cached anonymous page and its references) besides
 * asking the generic "may this requester see unrated material" question. Each of
 * those used to be its own round trip.
 *
 * Within one request this module:
 *   - coalesces every decision asked in the same tick into one batch call;
 *   - answers a decision it already received for the identical input again
 *     without another call.
 *
 * Nothing outlives the request. A decision is never shared across requests,
 * viewers or requesters, so a privacy, supervision, contact or block change is
 * still read on the very next request — the same request-local graph Oxy itself
 * builds and never carries across requests. A failed call rejects every waiter
 * (fail closed) and is not remembered, and an item Oxy leaves unanswered is
 * `unavailable`. Outside a request scope (workers, sockets) each call is its own
 * batch, exactly as before.
 */

/** Oxy's batch bound; resource IDs must also be unique within one call. */
const MAX_BATCH_ITEMS = 100;
/** Concurrent chunk calls for a graph larger than one batch. */
const MAX_CONCURRENT_BATCHES = 4;

const unavailable: SafetyDecision = {
  allowed: false,
  reason: 'unavailable',
  policyVersion: '2',
};

/**
 * The generic "unrated, unauthored material" question: may this requester see
 * an attachment, byline image, card or recommendation nobody has rated? It has
 * one answer per requester, so every caller asks the identical item and a
 * request pays for it at most once — inside the batch that decides its posts.
 */
export const UNRATED_MATERIAL_ITEM: ContentAccessInput = {
  resourceId: 'mention:unrated-material',
  classification: 'unrated',
};

interface Pending {
  item: ContentAccessInput;
  resolve: (decision: SafetyDecision) => void;
  reject: (error: unknown) => void;
}

interface RequesterQueue {
  requester: SafetyRequester;
  pending: Pending[];
}

class ContentAccessScope {
  private readonly decisions = new Map<string, Promise<SafetyDecision>>();
  private readonly queues = new Map<string, RequesterQueue>();
  private flushScheduled = false;

  decide(item: ContentAccessInput, requester: SafetyRequester): Promise<SafetyDecision> {
    const requesterKey = keyOfRequester(requester);
    const key = `${requesterKey}\u0000${keyOfItem(item)}`;
    const known = this.decisions.get(key);
    if (known) return known;
    const decision = new Promise<SafetyDecision>((resolve, reject) => {
      let queue = this.queues.get(requesterKey);
      if (!queue) {
        queue = { requester, pending: [] };
        this.queues.set(requesterKey, queue);
      }
      queue.pending.push({ item, resolve, reject });
    });
    this.decisions.set(key, decision);
    // A failure is not an answer: forget it so it is never served as one.
    decision.catch(() => {
      if (this.decisions.get(key) === decision) this.decisions.delete(key);
    });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return decision;
  }

  private flush(): void {
    this.flushScheduled = false;
    const queues = [...this.queues.values()];
    this.queues.clear();
    for (const { requester, pending } of queues) void sendBatches(pending, requester);
  }
}

const storage = new AsyncLocalStorage<ContentAccessScope>();

/** Run `fn` with its own content-decision scope. */
export function runWithContentAccessScope<T>(fn: () => T): T {
  return storage.run(new ContentAccessScope(), fn);
}

/** Express middleware: one content-decision scope per HTTP request. */
export function contentAccessScope(_req: Request, _res: Response, next: NextFunction): void {
  runWithContentAccessScope(next);
}

/**
 * Decide `items` for `requester`, keyed by resource ID. Duplicate resource IDs
 * within one call must carry identical inputs (callers dedupe their graph).
 */
export async function decideContentAccess(
  items: readonly ContentAccessInput[],
  requester: SafetyRequester,
): Promise<Map<string, SafetyDecision>> {
  if (!items.length) return new Map();
  const scope = storage.getStore() ?? new ContentAccessScope();
  const decisions = await Promise.all(items.map((item) => scope.decide(item, requester)));
  return new Map(items.map((item, index) => [item.resourceId, decisions[index]]));
}

/** May `requester` see unrated, unauthored material (see {@link UNRATED_MATERIAL_ITEM})? */
export async function canSeeUnratedMaterial(requester: SafetyRequester): Promise<boolean> {
  const decisions = await decideContentAccess([UNRATED_MATERIAL_ITEM], requester);
  return decisions.get(UNRATED_MATERIAL_ITEM.resourceId)?.allowed === true;
}

async function sendBatches(pending: Pending[], requester: SafetyRequester): Promise<void> {
  // Chunks of at most 100 with unique resource IDs. A resource asked twice with
  // different inputs (a `manage_own` and a `read` of the same post) goes to a
  // later chunk rather than being merged into an ambiguous answer.
  const chunks: Pending[][] = [];
  for (const entry of pending) {
    const chunk = chunks.find(
      (candidate) =>
        candidate.length < MAX_BATCH_ITEMS &&
        !candidate.some((other) => other.item.resourceId === entry.item.resourceId),
    );
    if (chunk) chunk.push(entry);
    else chunks.push([entry]);
  }
  const client = getServiceOxyClient();
  const run = async (chunk: Pending[]) => {
    try {
      const result = await client.safety.contentAccessBatch(
        { items: chunk.map((entry) => entry.item) },
        requester,
      );
      const byId = new Map(result.items.map((item) => [item.resourceId, item.decision]));
      for (const entry of chunk) entry.resolve(byId.get(entry.item.resourceId) ?? unavailable);
    } catch (error) {
      for (const entry of chunk) entry.reject(error);
    }
  };
  for (let index = 0; index < chunks.length; index += MAX_CONCURRENT_BATCHES)
    await Promise.all(chunks.slice(index, index + MAX_CONCURRENT_BATCHES).map(run));
}

function keyOfRequester(requester: SafetyRequester): string {
  if ('connectionToken' in requester) return `connection:${requester.connectionToken}`;
  if ('capabilityTicket' in requester) return `ticket:${requester.capabilityTicket}`;
  if ('requesterContext' in requester) return `context:${requester.requesterContext}`;
  return requester.accessToken ? `session:${requester.accessToken}` : 'anonymous';
}

function keyOfItem(item: ContentAccessInput): string {
  return JSON.stringify([
    item.resourceId,
    item.classification,
    item.authorAccountId ?? null,
    item.audience ?? null,
    item.applicationAudienceAllowed ?? null,
    item.applicationResourceGrant ?? null,
    item.operation ?? null,
  ]);
}
