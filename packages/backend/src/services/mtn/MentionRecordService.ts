/**
 * Mention Record Service — the thin WRITE API over the @oxyhq/protocol chain
 * engine for the MTN Protocol (`app.mention.feed.*`).
 *
 * `signAndAppend(oxyUserId, collection, rkey, payload)` is the one builder the
 * dual-write side-effects call:
 *
 *  1. build the subject DID (`buildUserDid(oxyUserId)`),
 *  2. read the subject's current chain head (`mentionRecordStore.getHead`),
 *  3. derive the next chain coordinates (`seq = head.seq + 1`, `prev = head id`,
 *     genesis `seq: 0` / `prev: null`),
 *  4. build the v2 envelope signing fields (`type: 'app_record'`, `collection`,
 *     `rkey`, `issuer: MENTION_DID`),
 *  5. CUSTODIALLY sign it with `MENTION_PRIVATE_KEY` (web/server path — native
 *     client co-signing is a later seam),
 *  6. compute the `recordId` and `verifyAndAppend` it via the engine with the
 *     Mention store + resolver injected.
 *
 * On a `chain_conflict` / `bad_seq` (a concurrent writer took this `seq`) it
 * re-reads the head and retries up to {@link MAX_APPEND_ATTEMPTS} times.
 *
 * INERT-WITHOUT-ENV: when the custodial key is unconfigured the service is a
 * logged no-op (returns `{ ok: false, reason: 'disabled' }`), so the dual-write
 * degrades gracefully — Mongo stays authoritative and nothing else changes.
 *
 * This NEVER throws to its callers in the dual-write path; all emission is
 * best-effort and isolated by the caller's `Promise.allSettled`.
 */

import {
  signEnvelope,
  computeRecordId,
  verifyAndAppend,
  type SignedRecordSigningFields,
  type RejectionReason,
  type AppendOutcome,
} from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { logger } from '../../utils/logger';
import { buildUserDid } from './mentionDid';
import { mentionRecordStore } from './MentionRecordStore';
import { mentionVerificationResolver } from './mentionVerificationResolver';
import {
  getMentionCustodialIssuer,
  getMentionCustodialPrivateKey,
  isMentionRecordSigningEnabled,
} from './mentionRecordEnv';

/** The open envelope `type` Mention signs every v2 app record under. */
const MENTION_RECORD_TYPE = 'app_record';

/** Retries on a concurrent-writer `chain_conflict` / `bad_seq` before giving up. */
const MAX_APPEND_ATTEMPTS = 5;

/** The conflict reasons that warrant re-reading the head and retrying. */
const RETRYABLE_REASONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  'chain_conflict',
  'bad_seq',
  'chain_fork',
  'chain_gap',
]);

export type SignAndAppendResult =
  | { ok: true; recordId: string; seq: number; envelope: SignedRecordEnvelope }
  | { ok: false; reason: RejectionReason | 'disabled' | 'error' };

/**
 * Build, custodially-sign, and append an MTN record to `oxyUserId`'s chain.
 *
 * @param oxyUserId  The local author's Oxy account id (the chain subject).
 * @param collection The MTN collection NSID (`app.mention.feed.*`).
 * @param rkey       The record key (the Mongo `_id` of the post/like/etc.).
 * @param payload    The lexicon `record` payload (already in wire shape).
 */
export async function signAndAppend(
  oxyUserId: string,
  collection: string,
  rkey: string,
  payload: Record<string, unknown>,
): Promise<SignAndAppendResult> {
  const issuer = getMentionCustodialIssuer();
  const privateKey = getMentionCustodialPrivateKey();
  // INERT-WITHOUT-ENV: both must be present (and `getMentionCustodialPublicKey`,
  // checked by the resolver) or the dual-write is a logged no-op.
  if (!isMentionRecordSigningEnabled() || !issuer || !privateKey) {
    logger.debug('MentionRecordService: signing disabled (MENTION_DID/keys unset); skipping emission', {
      collection,
      rkey,
    });
    return { ok: false, reason: 'disabled' };
  }

  const subject = buildUserDid(oxyUserId);

  let lastReason: RejectionReason = 'chain_conflict';

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      const head = await mentionRecordStore.getHead(subject);
      const seq = head ? head.seq + 1 : 0;
      const prev = head ? head.headRecordId : null;

      const fields: SignedRecordSigningFields = {
        version: 2,
        type: MENTION_RECORD_TYPE,
        subject,
        issuer,
        record: payload,
        issuedAt: Date.now(),
        seq,
        prev,
        collection,
        rkey,
      };

      const envelope = await signEnvelope(fields, privateKey);
      const recordId = await computeRecordId(fields);
      const outcome = await verifyAndAppend(mentionRecordStore, mentionVerificationResolver, envelope);

      if (outcome.ok) {
        return { ok: true, recordId: outcome.recordId, seq: outcome.seq, envelope };
      }

      lastReason = outcome.reason;
      if (!RETRYABLE_REASONS.has(outcome.reason)) {
        // A non-retryable rejection (e.g. untrusted_issuer, bad_signature,
        // stale_issued_at) will never succeed on retry — stop.
        logger.warn('MentionRecordService: record append rejected', {
          collection,
          rkey,
          reason: outcome.reason,
        });
        return { ok: false, reason: outcome.reason };
      }
      // Retryable: loop, re-read the head, rebuild with the next seq.
    } catch (error) {
      logger.error('MentionRecordService: signAndAppend threw', {
        collection,
        rkey,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: 'error' };
    }
  }

  logger.warn('MentionRecordService: append exhausted retries', {
    collection,
    rkey,
    reason: lastReason,
  });
  return { ok: false, reason: lastReason };
}

/**
 * Re-verify a signed record (signed ELSEWHERE — on a user's node, or a
 * custodial managed-vault record) and append it to its subject's chain.
 *
 * This is the INGEST chokepoint: it delegates to the app-agnostic
 * `@oxyhq/protocol` engine with the SAME Mention store + resolver the dual-write
 * uses, so a record pulled from an untrusted node is held to the identical trust
 * boundary as a locally-signed one — the signature is re-checked over the
 * canonical input, the `recordId` is recomputed, the signing key must be a
 * CURRENT verification method of the subject's DID (self-issued) or the Mention
 * custodial key (`issuer === MENTION_DID`), freshness is enforced, and v2 chain
 * continuity is validated. A node can therefore never inject a record the user
 * did not sign.
 *
 * Unlike {@link signAndAppend}, the caller supplies the ENVELOPE verbatim (it was
 * signed elsewhere) — this function NEVER signs. The returned {@link AppendOutcome}
 * carries the chain coordinates on success, or the {@link RejectionReason} the
 * ingest worker routes to LWW-skip / fork-preserve / hard-reject.
 *
 * @param envelope The verbatim signed envelope to re-verify + append.
 */
export async function verifyAndStoreRecord(envelope: SignedRecordEnvelope): Promise<AppendOutcome> {
  return verifyAndAppend(mentionRecordStore, mentionVerificationResolver, envelope);
}
