/**
 * Mention VerificationMethodResolver — the identity HALF of the MTN chain
 * adapter.
 *
 * This is the Mention AUTHORIZATION policy the app-agnostic `@oxy.so/protocol`
 * engine delegates to: given a subject DID, it resolves the SUBJECT's current
 * Oxy verification methods (so a native, user-signed record where
 * `issuer === subject` is accepted) PLUS the Mention CUSTODIAL branch (so a
 * server-signed provenance record where `issuer === MENTION_DID` is accepted).
 * The engine's `isAuthorizedKey` then applies the uniform rule:
 *
 *  - self-issued (`issuer === subject`)  ⇒ key ∈ the subject's Oxy VMs,
 *  - custodial   (`issuer === MENTION_DID`) ⇒ key === `MENTION_PUBLIC_KEY`,
 *  - anything else ⇒ `untrusted_issuer`.
 *
 * The SUBJECT's VMs come from Oxy (the user's `did:web` document, fetched via
 * `oxyServices.resolveDid` with the backend service token), cached briefly to
 * keep the hot path off the network. The custodial key is Mention's own
 * published key (`MENTION_PUBLIC_KEY`) — it is NOT a secret (a verification
 * method of `MENTION_DID`), so a plain-equality compare in the engine is
 * sufficient. The signature is still verified against `env.publicKey`, so only
 * the holder of `MENTION_PRIVATE_KEY` (this server) can mint a custodial record
 * that passes BOTH the custodial-key check and the signature check.
 *
 * INERT-WITHOUT-ENV: when `MENTION_DID`/`MENTION_PUBLIC_KEY` are unset, the
 * custodial branch is omitted so a custodial record can never verify in an
 * environment with no Mention key — the dual-write degrades to native-only.
 */

import type { ResolvedVerificationMethods, VerificationMethodResolver } from '@oxy.so/protocol';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';
import { getMentionCustodialIssuer, getMentionCustodialPublicKey } from './mentionRecordEnv';
import { parseUserDid } from './mentionDid';

/** How long a resolved subject VM set is cached before re-resolving. */
const VM_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * How long a FAILED resolution is remembered. Short, so a transient Oxy error
 * self-heals quickly, but long enough that a burst of ingests for one subject
 * cannot re-ask Oxy on every record: every Oxy call from this backend shares one
 * egress-IP rate budget with user-facing reads (feed privacy lists), so an
 * unthrottled retry loop here turns an Oxy 429 into feed 500s.
 */
const VM_FAILURE_TTL_MS = 60 * 1000;

interface CachedVms {
  keys: string[];
  expiresAt: number;
}

const vmCache = new Map<string, CachedVms>();
const inFlight = new Map<string, Promise<string[]>>();

/**
 * Resolve the subject's CURRENT Oxy verification-method public keys (hex) from
 * its `did:web` document, cached for {@link VM_CACHE_TTL_MS}. Returns an empty
 * array when the subject has no resolvable keys (e.g. a custodial-only account or
 * an unresolvable DID) — the custodial branch can still authorize such a record.
 * Concurrent resolutions for one subject share a single Oxy call.
 */
async function resolveSubjectPublicKeys(oxyUserId: string): Promise<string[]> {
  const cached = vmCache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }
  const pending = inFlight.get(oxyUserId);
  if (pending) return pending;

  const resolution = fetchSubjectPublicKeys(oxyUserId).finally(() => {
    inFlight.delete(oxyUserId);
  });
  inFlight.set(oxyUserId, resolution);
  return resolution;
}

async function fetchSubjectPublicKeys(oxyUserId: string): Promise<string[]> {
  try {
    const doc = await getServiceOxyClient().resolveDid(oxyUserId);
    // `VerificationMethod` is a discriminated union (the Oxy secp256k1 form
    // carries `publicKeyHex`; the atproto-bridge `Multikey` form carries
    // `publicKeyMultibase` instead) — Mention's chain only ever signs with the
    // secp256k1 form, so a `Multikey` entry has no `publicKeyHex` and the
    // narrowed access below yields `undefined`, dropped by the same filter
    // that already handled a malformed/incomplete verification method.
    const keys = (doc.verificationMethod ?? [])
      .map((vm) => ('publicKeyHex' in vm ? vm.publicKeyHex : undefined))
      .filter((key): key is string => typeof key === 'string' && key.length > 0);
    vmCache.set(oxyUserId, { keys, expiresAt: Date.now() + VM_CACHE_TTL_MS });
    return keys;
  } catch (error) {
    // A resolution failure must not authorize a record; return no keys (the
    // custodial branch may still apply). An empty key set authorizes nothing,
    // so remembering it briefly is fail-closed — it only stops the retry storm.
    vmCache.set(oxyUserId, { keys: [], expiresAt: Date.now() + VM_FAILURE_TTL_MS });
    logger.warn('mentionVerificationResolver: failed to resolve subject DID', {
      oxyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Clear the cached subject VMs (test seam / explicit invalidation). */
export function clearVerificationMethodCache(): void {
  vmCache.clear();
  inFlight.clear();
}

/** The Mention custodial branch, or nothing when its env is unconfigured. */
function custodialBranch(): Pick<ResolvedVerificationMethods, 'custodialIssuer' | 'custodialPublicKey'> {
  const custodialIssuer = getMentionCustodialIssuer();
  const custodialPublicKey = getMentionCustodialPublicKey();
  // Both present or both absent: when the Mention custodial key is
  // unconfigured the custodial branch is omitted entirely.
  return custodialIssuer && custodialPublicKey ? { custodialIssuer, custodialPublicKey } : {};
}

/**
 * The Mention resolver: maps a subject DID → its current Oxy verification
 * methods + the Mention custodial issuer. Returns `null` only when the DID is
 * not a user DID (no key is then authorized).
 */
export const mentionVerificationResolver: VerificationMethodResolver = {
  async resolve(subjectDid: string): Promise<ResolvedVerificationMethods | null> {
    const oxyUserId = parseUserDid(subjectDid);
    if (!oxyUserId) {
      return null;
    }

    const currentPublicKeys = await resolveSubjectPublicKeys(oxyUserId);
    return { currentPublicKeys, ...custodialBranch() };
  },
};

/**
 * The resolver for records THIS server signs with the custodial key.
 *
 * Such an envelope's issuer is `MENTION_DID`, never the subject, so the engine's
 * `isAuthorizedKey` decides it from the custodial branch alone — the subject's
 * Oxy verification methods are never consulted. Resolving them anyway cost one
 * Oxy DID lookup per dual-write, which under a write burst exhausted the shared
 * Oxy rate budget. Signature, freshness and chain checks still run unchanged, and
 * a self-issued envelope verified with this resolver has no keys to match, so it
 * can only be rejected.
 */
export const mentionCustodialVerificationResolver: VerificationMethodResolver = {
  async resolve(subjectDid: string): Promise<ResolvedVerificationMethods | null> {
    if (!parseUserDid(subjectDid)) {
      return null;
    }
    return { currentPublicKeys: [], ...custodialBranch() };
  },
};
