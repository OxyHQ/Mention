/**
 * Mention VerificationMethodResolver — the identity HALF of the MTN chain
 * adapter.
 *
 * This is the Mention AUTHORIZATION policy the app-agnostic `@oxyhq/protocol`
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

import type { ResolvedVerificationMethods, VerificationMethodResolver } from '@oxyhq/protocol';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';
import { getMentionCustodialIssuer, getMentionCustodialPublicKey } from './mentionRecordEnv';
import { parseUserDid } from './mentionDid';

/** How long a resolved subject VM set is cached before re-resolving. */
const VM_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedVms {
  keys: string[];
  expiresAt: number;
}

const vmCache = new Map<string, CachedVms>();

/**
 * Resolve the subject's CURRENT Oxy verification-method public keys (hex) from
 * its `did:web` document, cached for {@link VM_CACHE_TTL_MS}. Returns an empty
 * array when the subject has no resolvable keys (e.g. a custodial-only account or
 * an unresolvable DID) — the custodial branch can still authorize such a record.
 */
async function resolveSubjectPublicKeys(oxyUserId: string): Promise<string[]> {
  const cached = vmCache.get(oxyUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }
  try {
    const doc = await getServiceOxyClient().resolveDid(oxyUserId);
    const keys = (doc.verificationMethod ?? [])
      .map((vm) => vm.publicKeyHex)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);
    vmCache.set(oxyUserId, { keys, expiresAt: Date.now() + VM_CACHE_TTL_MS });
    return keys;
  } catch (error) {
    // A resolution failure must not authorize a record; return no keys (the
    // custodial branch may still apply). Do NOT cache a transient failure.
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
    const custodialIssuer = getMentionCustodialIssuer();
    const custodialPublicKey = getMentionCustodialPublicKey();

    return {
      currentPublicKeys,
      // Both present or both absent: when the Mention custodial key is
      // unconfigured the custodial branch is omitted entirely.
      ...(custodialIssuer && custodialPublicKey
        ? { custodialIssuer, custodialPublicKey }
        : {}),
    };
  },
};
