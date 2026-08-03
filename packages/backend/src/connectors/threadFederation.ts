/**
 * Outbound federation for a batch written in ONE action — a thread or a beast
 * batch from `POST /posts/thread`.
 *
 * Every entry federates as its own `Create(Note)`, and a thread's continuations
 * carry `inReplyTo` pointing at the entry before them. That is how Mastodon
 * represents a thread, and it is the only shape that works here: all three AP
 * author surfaces filter `parentPostId: null` (the outbox count, the outbox page
 * and the featured collection, `activitypub/routes/ap.routes.ts`) and a Note we
 * emit advertises no `replies` collection, so a continuation that is not PUSHED
 * is unreachable by every other means. "Federate only the root" is not a smaller
 * version of this feature; it is publishing the first paragraph and discarding
 * the rest.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS HERE RATHER THAN INSIDE `PostCreationService.create`
 *
 * `createThread` suppresses that service's whole side-effect stage
 * (`skipNotifications`), because a thread runs its own per-entry mention
 * notifications and one socket emit for the batch — and the federation stage
 * sits behind the same early return, which is why a published thread federated
 * NOTHING while the same thread SCHEDULED federated completely (the scheduled
 * publisher runs the full pipeline per entry when the time arrives). This module
 * restores the missing half for the immediate path without reinstating the
 * notification stage the controller replaced.
 *
 * It runs DETACHED, after the rows are written, and never blocks the response.
 * That is not tidiness: each entry's fan-out calls the SSRF guard once per
 * target inbox and that guard resolves DNS, so doing this in-band would put
 * `entries × inboxes` DNS lookups in front of the HTTP response. It also makes
 * the published path look like the scheduled one, which is the path that already
 * works.
 *
 * ---------------------------------------------------------------------------
 * ORDERING: ENQUEUES ARE ORDERED, ARRIVALS ARE NOT — AND THAT IS ACCEPTED
 *
 * This walks the chain parent-first and awaits each entry before starting the
 * next, so deliveries are ENQUEUED in thread order. It does not follow that they
 * ARRIVE in that order: `deliverToFollowers` enqueues one BullMQ job per inbox,
 * the delivery worker runs `DELIVERY_WORKER_CONCURRENCY` jobs at a time, and
 * several ECS tasks share the queue. A real ordering guarantee would need
 * per-inbox job chaining inside `@oxyhq/federation`, which is a different
 * package and a different release; this is exact parity with what the scheduled
 * path already ships (`ScheduledPostPublisher` orders its publishes, not its
 * deliveries), so it adds no risk that is not already live.
 *
 * What that costs on the far side, measured against Mastodon's source so nobody
 * has to read it again:
 *
 *  - A continuation whose parent has not been resolved yet is DROPPED from every
 *    home timeline: `feed_manager.rb` returns `:filter` when a status is a reply
 *    (`reply` is set from `inReplyTo` being present, independent of whether the
 *    parent resolved) and `in_reply_to_id` is nil.
 *  - Mastodon then fetches the parent asynchronously (`ThreadResolveWorker`,
 *    enqueued just before distribution, so it is a genuine race and the fetch
 *    side is the slow one). Our per-post dereference route serves exactly the
 *    `inReplyTo` id we mint, so that fetch succeeds.
 *  - From **v4.3.0** that worker re-runs distribution once the parent is
 *    attached, so a late arrival self-heals. On 4.2 and older it does not: the
 *    continuation stays out of home timelines permanently, though it is correct
 *    in the thread view and on the author's "posts and replies" tab.
 *  - DISPLAY order is safe either way. Mastodon derives a status id from
 *    `created_at` when that is in the past (`Mastodon::Snowflake::Callbacks`),
 *    and home feeds are scored by id — so out-of-order arrival still renders in
 *    the order we published.
 *
 * A same-account thread is the well-behaved case: `feed_manager.rb` exempts a
 * SELF-reply from the "reply to somebody you do not follow" filter, so once the
 * parent is known the continuations belong on followers' timelines.
 *
 * ---------------------------------------------------------------------------
 * CONSENT: A CHAIN STOPS AT THE FIRST ENTRY THAT STAYS HOME
 *
 * Fediverse sharing is per ACCOUNT, and a thread may now carry several. Each
 * entry is gated on its OWN author's consent — that part is the registry's
 * standing rule and needs nothing new. What is new is that a chain STOPS there
 * rather than skipping ahead, because an answer to an entry that stayed home
 * publishes that author's handle and the existence of their post whatever their
 * setting says. The full reasoning is at the refusal itself.
 */

import type { IPost } from '../models/Post';
import { logger } from '../utils/logger';
import { isFediverseSharingEnabled } from '../services/fediverseSharing';
import { postCreationService } from '../services/PostCreationService';

/** How a batch's entries relate to one another, which decides two behaviours. */
export type BatchFederationShape =
  /**
   * A THREAD: entry `i` is a reply to entry `i - 1`. Federation stops at the
   * first entry that does not go out, and every entry is offered to the other
   * participating accounts' audiences.
   */
  | 'chain'
  /**
   * A BEAST batch: n independent top-level posts that happen to share one
   * action. No entry references another, so one that cannot federate holds
   * nothing else back.
   */
  | 'independent';

/**
 * Federate a batch of already-written local posts.
 *
 * Awaitable so it can be tested; production calls {@link federatePostBatchDetached}.
 * `entries` MUST be in publication order — for a chain that is what makes the
 * parent of `entries[i]` be `entries[i - 1]`, which is what lets a chain stop at
 * a hole rather than having to re-read each parent to find one.
 *
 * Never throws. A batch is best-effort by construction: the rows are already
 * committed and the user has already been told the thread was published.
 */
export async function federatePostBatch(params: {
  entries: IPost[];
  shape: BatchFederationShape;
}): Promise<void> {
  const { entries, shape } = params;
  if (entries.length === 0) return;

  const authorOf = (entry: IPost): string => String(entry.oxyUserId ?? '');

  // One consent read per DISTINCT account for the whole batch, resolved up
  // front. A single-voice thread therefore asks once however long it is, and
  // both later decisions — whether an entry may go out at all, and whose
  // audiences are worth widening to — are answered from memory.
  const participants = [...new Set(entries.map(authorOf).filter(Boolean))];
  const sharingByAccount = new Map<string, boolean>();
  await Promise.all(
    participants.map(async (accountId) => {
      sharingByAccount.set(accountId, await isFediverseSharingEnabled(accountId));
    }),
  );
  const shares = (accountId: string): boolean => sharingByAccount.get(accountId) === true;

  // The other accounts a chain's entries may be offered to, minus any that does
  // not federate at all. Empty for a beast batch, whose entries share no
  // conversation — and an empty list is what makes the connector registry fall
  // straight through to its ordinary delivery path.
  //
  // No `participants.length > 1` test: a single-voice thread has one
  // participant, and the per-entry `!== author` filter below already removes it.
  // The test was written here first and mutation-testing could not tell its
  // presence from its absence.
  const audienceCandidates = shape === 'chain' ? participants.filter(shares) : [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const author = authorOf(entry);

    // AN ENTRY THAT CANNOT FEDERATE ENDS A CHAIN — it does not get skipped over.
    //
    // This is where the consent rule lives, and stopping is the whole of it. A
    // continuation carries its parent's canonical AP url as `inReplyTo` AND a
    // `Mention` tag naming `@<parent author>@<domain>`, so federating an answer
    // to an entry that stayed home publishes that author's handle and the
    // existence of their post to every instance that receives the answer — the
    // url 404s and their webfinger 404s, and the handle is on the wire anyway.
    // That is a leak, not a gap. It would ALSO dangle: the remote side can never
    // fetch the link, so Mastodon drops the answer from every home timeline
    // (see the ordering note above) and shows a thread with a hole in it.
    //
    // Stopping at the first entry that does not go out covers the parent case by
    // construction — a chain only reaches entry `i` by having delivered entry
    // `i - 1`, which IS its parent, so an explicit "is my parent's author
    // silent?" test can never fire. One was written here first, keyed on
    // `entries[i - 1]`, and mutation-testing proved nothing could distinguish
    // its presence from its absence. The BEHAVIOUR is what matters and it is
    // pinned by tests; a second rule that cannot fail would only spend the next
    // reader's trust.
    //
    // A beast batch has no chain to end: its entries answer nothing, so one
    // account's silence removes only that account's own posts.
    //
    // An author that will not resolve is absent from the consent map, so it
    // reads as not sharing and takes this branch — the safe direction, and the
    // reason no separate emptiness test is needed.
    if (!shares(author)) {
      if (shape === 'chain') {
        logger.debug('[ThreadFederation] chain stops: author does not share to the fediverse');
        return;
      }
      continue;
    }

    const delivered = await postCreationService.federatePublishedPost(entry, {
      oxyUserId: author,
      alsoDeliverToAudiencesOf: audienceCandidates.filter((id) => id !== author),
    });

    // An entry that did not go out — unpublished, an unresolvable username, a
    // connector failure — leaves every later link of a chain pointing at
    // something no remote server can fetch.
    if (!delivered && shape === 'chain') {
      logger.warn('[ThreadFederation] chain stops: an entry was not delivered');
      return;
    }
  }
}

/**
 * Fire-and-forget {@link federatePostBatch} — the production entry point.
 *
 * Mirrors `outboundFederation.federateAsResolvedActor`: the work is detached so
 * it never blocks or fails the HTTP response, and the rejection handler is what
 * keeps a failure from surfacing as an unhandled rejection.
 */
export function federatePostBatchDetached(params: {
  entries: IPost[];
  shape: BatchFederationShape;
}): void {
  void federatePostBatch(params).catch((err) => {
    logger.error('[ThreadFederation] failed to federate a batch', err);
  });
}
