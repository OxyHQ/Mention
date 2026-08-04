/**
 * One-shot admin backfill: qualify the bare `@handle`s inside ALREADY-STORED
 * federated post bodies.
 *
 * A handle written on another network means the account THERE. Ingest now stores
 * `@Julio_Rodr_@x.com`, but a post body is written ONCE — unlike an actor's bio,
 * which every refresh rewrites — so everything imported before that change keeps
 * a bare `@Julio_Rodr_`, which reads as a LOCAL name and links to whoever holds
 * it here. This repairs the history.
 *
 * IT USES THE SAME FUNCTION THE INGEST PATH USES. `qualifyBareHandles` scans with
 * the shared entity scanner, so a URL's `@handle`, an email and a mention already
 * hydrated into a placeholder are excluded by the one definition rather than by a
 * rule invented for the backfill — which is the only way a backfill and a live
 * path can be guaranteed to agree. It is idempotent (asserted in the scanner's
 * own suite), so a re-run is a no-op and an interrupted run is safe to resume.
 *
 * THE DOMAIN IS THE IDENTITY'S, NEVER THE HOST THE COPY ARRIVED THROUGH. A
 * re-labelled bridge actor stores `domain: mastox.eu` while its identity is on
 * `x.com`; `identityDomainOfActor` reads `networkAcct` first for exactly that
 * reason. Getting this backwards would pin every handle in every historical body
 * onto a bridge hostname.
 *
 * SELECTION:
 *  1. Posts whose author has a `FederatedActor` row — a local user's post is
 *     never touched, because a bare handle there already means a local account.
 *  2. Of those, only bodies the qualifier actually CHANGES. A post whose handles
 *     are already qualified, or which has none, is not written at all.
 *
 * SAFETY:
 *  1. `BACKFILL_DRY_RUN` defaults to `'true'`. It reports what WOULD change,
 *     with before/after samples, and writes nothing. Only `=false` writes.
 *  2. `BACKFILL_MAX` (default 5000) caps the run; overflow is reported, never
 *     silently dropped.
 *  3. Every write is a targeted `$set` of `content.variants` for one post id.
 *     Nothing else on the document is read back and re-saved, so a concurrent
 *     edit to another field cannot be clobbered by this script.
 *  4. An actor with no resolvable identity domain is SKIPPED, not guessed at.
 *
 * Runnable as a Fargate one-shot:
 *   BACKFILL_DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillFederatedHandleQualification \
 *   bun packages/backend/dist/src/scripts/backfillFederatedHandleQualification.js
 */

import mongoose from 'mongoose';
import { qualifyBareHandles } from '@mention/shared-types/textEntities';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import Post from '../models/Post';
import FederatedActor, { type IFederatedActor } from '../models/FederatedActor';
import { identityDomainOfActor } from '../connectors/activitypub/identityDomain';

const DRY_RUN = (process.env.BACKFILL_DRY_RUN ?? 'true') !== 'false';
const MAX = Number(process.env.BACKFILL_MAX ?? 5000);

interface StoredVariant { source?: string; text?: string; tag?: string }

/** The qualified variants, or `null` when nothing changed. */
function qualifyVariants(variants: StoredVariant[], domain: string): StoredVariant[] | null {
  let changed = false;
  const next = variants.map((variant) => {
    if (typeof variant.text !== 'string') return variant;
    const text = qualifyBareHandles(variant.text, domain);
    if (text === variant.text) return variant;
    changed = true;
    return { ...variant, text };
  });
  return changed ? next : null;
}

const SCRIPT_NAME = 'backfillFederatedHandleQualification';

async function main(): Promise<void> {
  // The shared guard, not a local one: a mutating run is refused in EVERY
  // environment until the operator names this script back, because a production
  // URI can be paired with any NODE_ENV label. Dry runs need no token.
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: DRY_RUN });
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  await mongoose.connect(mongoUri, { dbName: `mention-${process.env.NODE_ENV || 'development'}` });
  logger.info('[Backfill] handle qualification starting', { dryRun: DRY_RUN, max: MAX });

  // One pass over the actors, so the per-post work is a map lookup rather than a
  // query. `oxyUserId` is what a post is authored by.
  const actors = await FederatedActor
    .find({ oxyUserId: { $exists: true, $ne: null } }, { oxyUserId: 1, networkAcct: 1, domain: 1 })
    .lean<Array<Pick<IFederatedActor, 'oxyUserId' | 'networkAcct' | 'domain'>>>();

  const domainByUser = new Map<string, string>();
  for (const actor of actors) {
    const domain = identityDomainOfActor(actor);
    if (actor.oxyUserId && domain) domainByUser.set(String(actor.oxyUserId), domain);
  }
  logger.info('[Backfill] federated authors with a resolvable identity domain', {
    actors: actors.length,
    usable: domainByUser.size,
  });

  let scanned = 0;
  let changed = 0;
  let written = 0;
  const samples: Array<{ id: string; before: string; after: string }> = [];

  const cursor = Post
    .find({ oxyUserId: { $in: [...domainByUser.keys()] } }, { oxyUserId: 1, 'content.variants': 1 })
    .limit(MAX)
    .cursor();

  for await (const post of cursor) {
    scanned += 1;
    const domain = domainByUser.get(String(post.oxyUserId));
    if (!domain) continue;
    const variants = (post.content?.variants ?? []) as StoredVariant[];
    const next = qualifyVariants(variants, domain);
    if (!next) continue;

    changed += 1;
    if (samples.length < 5) {
      samples.push({
        id: String(post._id),
        before: (variants[0]?.text ?? '').slice(0, 120),
        after: (next[0]?.text ?? '').slice(0, 120),
      });
    }
    if (!DRY_RUN) {
      await Post.updateOne({ _id: post._id }, { $set: { 'content.variants': next } });
      written += 1;
    }
  }

  logger.info('[Backfill] handle qualification complete', {
    dryRun: DRY_RUN,
    scanned,
    changed,
    written,
    cappedAt: scanned >= MAX ? MAX : undefined,
    samples,
  });
  await mongoose.disconnect();
}

main().catch((error) => {
  logger.error('[Backfill] handle qualification failed', {
    reason: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
});
