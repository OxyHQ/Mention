import type { NormalizedExternalActor } from '@oxy.so/federation';
import { logger } from '../../utils/logger';
import {
  findActorByUri,
  findIdentityOwnerActor,
  loadActorFields,
} from '../../db/federation/actorRepository';
import {
  findIdentityClaimsBySubject,
  findIdentityClaimsByTarget,
  findIdentityLinksFor,
  loadIdentityLinkEvidence,
  recordIdentityLink,
  replaceIdentityClaims,
} from '../../db/federation/identityEquivalenceRepository';
import {
  identityDomainOf,
  participatesInCrossNetworkIdentity,
} from './crossNetworkIdentityPolicy';
import { evaluateEquivalence } from './equivalenceEvidence';
import { readCrossNetworkIdentityClaims, type CrossNetworkIdentityClaim } from './identityClaims';

export {
  CROSS_NETWORK_IDENTITY_POLICY,
  findCrossNetworkPair,
  identityDomainOf,
  identityPairKey,
  participatesInCrossNetworkIdentity,
  type CrossNetworkIdentityPair,
} from './crossNetworkIdentityPolicy';
export {
  evaluateEquivalence,
  type EquivalenceReason,
  type EquivalenceVerdict,
} from './equivalenceEvidence';
export {
  readCrossNetworkIdentityClaims,
  type CrossNetworkIdentityClaim,
  type IdentityClaimKind,
} from './identityClaims';

/**
 * ONE PERSON, TWO NETWORKS — THE PART THAT TOUCHES THE DATABASE.
 *
 * `resolveFederatedActorIdentity` merges copies of an account ACROSS a network
 * and refuses between two, because `('x','nate')` and `('instagram','nate')` are
 * unrelated strings that happen to match. That stays true. This module is the
 * narrow, evidence-gated exception beside it: two identities on a REVIEWED pair
 * of networks (`./crossNetworkIdentityPolicy`) that each publish a
 * machine-readable assertion about the other may share one Oxy user.
 *
 * WHAT IT MOVES, AND WHAT IT LEAVES EXACTLY WHERE IT WAS
 *
 *   Only `oxy_user_id` is shared. Both actor rows keep their own URI, acct,
 *   domain, network identity and content, so `@zuck@instagram.com` and
 *   `@zuck@threads.net` remain two addressable source actors and two network
 *   aliases — the same shape the within-network bridged merge produces, and the
 *   reason a link can be withdrawn without anything needing to be rebuilt.
 *
 * IT IS RE-PROVED EVERY TIME, FROM CLAIMS PUBLISHED NOW
 *
 *   Nothing here ever adopts an identity because a link row says so. The stored
 *   link is an AUDIT RECORD — what was decided, on what evidence, when — and the
 *   decision itself is recomputed from the claims each side currently publishes.
 *   That is what makes a recycled handle safe: the next owner of a released
 *   Instagram handle publishes their own actor, which asserts nothing about the
 *   previous owner's Threads account, so the link is revoked on the first
 *   refresh instead of being inherited.
 *
 * IT WILL NOT RE-POINT AN IDENTITY THAT ALREADY MINTED ITS OWN USER
 *
 *   When both sides resolved separately before the evidence appeared, the proof
 *   is real but acting on it live would strand follows, blocks, moderation
 *   records and post authorship on an Oxy user nothing links to any more. So the
 *   pair is recorded `pending_reconciliation` and left alone;
 *   `scripts/reconcileCrossNetworkIdentities.ts` reports it for a decision.
 *   Refusing to act is the conservative half of "fail closed", and recording the
 *   proof is what keeps the refusal visible instead of silent.
 *
 * THE COST IS GATED ON THE POLICY, NOT PAID BY EVERY ACTOR
 *
 *   An actor whose identity domain is in no reviewed pair returns before any
 *   query runs — one in-memory set lookup. Every actor of every ordinary
 *   instance takes that path, which is why this can afford to read the actor's
 *   fields and both sides' claims on the path that does not.
 */

/** What {@link reconcileCrossNetworkIdentity} concluded for one actor. */
export interface CrossNetworkIdentityOutcome {
  /**
   * The Oxy user this actor should adopt, or `null` to resolve normally.
   *
   * `null` is the answer for the overwhelming majority of actors and for every
   * refusal, so a caller never has to distinguish "not applicable" from "refused"
   * to know what to do next.
   */
  readonly adoptOxyUserId: string | null;
  /** The counterpart identity, when one was linked — for the caller's log line. */
  readonly counterpartIdentity?: string;
}

const NOT_APPLICABLE: CrossNetworkIdentityOutcome = { adoptOxyUserId: null };

/** Every identity worth evaluating against this one: what we claim, and who claims us. */
function candidateIdentities(
  identity: string,
  ourClaims: readonly CrossNetworkIdentityClaim[],
  claimsAboutUs: readonly CrossNetworkIdentityClaim[],
): string[] {
  const candidates = new Set<string>();
  for (const claim of ourClaims) candidates.add(claim.target);
  for (const claim of claimsAboutUs) candidates.add(claim.subject);
  candidates.delete(identity);
  return [...candidates];
}

/**
 * Record this actor's current claims, then decide whether any of them — with the
 * counterpart's own — prove one person.
 *
 * Never throws: a failure here must not lose the actor, so it is logged and
 * answered as "not applicable", and the caller resolves the identity the way it
 * would have without this layer. The worst case is two identities that could
 * have been one, which the next refresh retries.
 */
export async function reconcileCrossNetworkIdentity(
  actor: NormalizedExternalActor,
): Promise<CrossNetworkIdentityOutcome> {
  const identity = actor.federatedUsername.trim().toLowerCase();
  const identityDomain = identityDomainOf(identity);
  if (!identityDomain || !participatesInCrossNetworkIdentity(identityDomain)) {
    return NOT_APPLICABLE;
  }

  try {
    const row = await findActorByUri(actor.externalId);
    // The shared resolver upserts the row before asking for an identity, so a
    // miss here means something further up already failed. Claim reading has
    // nothing to read; say so rather than guessing from the normalized actor,
    // which carries neither `alsoKnownAs` nor the profile fields.
    if (!row) return NOT_APPLICABLE;

    const fields = await loadActorFields(row.id);
    const ourClaims = readCrossNetworkIdentityClaims({
      federatedUsername: identity,
      actorUri: actor.externalId,
      alsoKnownAs: row.alsoKnownAs,
      fields,
    });
    await replaceIdentityClaims(actor.externalId, ourClaims);

    const claimsAboutUs = await findIdentityClaimsByTarget(identity);
    const candidates = candidateIdentities(identity, ourClaims, claimsAboutUs);

    /** Pairs this pass PROVED, so the rest can be revoked rather than left stale. */
    const proven = new Set<string>();
    let outcome: CrossNetworkIdentityOutcome = NOT_APPLICABLE;

    for (const candidate of candidates) {
      // Sequential on purpose: a proven pair ends the search, and the candidate
      // list is one or two entries in every shape the policy admits.
      // eslint-disable-next-line no-await-in-loop
      const theirClaims = await findIdentityClaimsBySubject(candidate);
      const verdict = evaluateEquivalence(
        { identity, claims: ourClaims },
        { identity: candidate, claims: theirClaims },
      );
      if (!verdict.linked) continue;

      // eslint-disable-next-line no-await-in-loop
      const counterpart = await findIdentityOwnerActor({
        federatedUsername: candidate,
        excludeUri: actor.externalId,
      });
      if (!counterpart) {
        // Proven, but the other half has not resolved to an Oxy user yet. There
        // is nothing to adopt and nothing to record a link against — the pair
        // settles when that side ingests and finds US, which is the same
        // eventual convergence the within-network merge relies on.
        continue;
      }

      proven.add(candidate);
      const diverged = Boolean(row.oxyUserId) && row.oxyUserId !== counterpart.oxyUserId;

      // eslint-disable-next-line no-await-in-loop
      await recordIdentityLink({
        identityA: identity,
        identityB: candidate,
        actorUriA: actor.externalId,
        actorUriB: counterpart.uri,
        status: diverged ? 'pending_reconciliation' : 'linked',
        oxyUserId: diverged ? undefined : counterpart.oxyUserId,
        reason: verdict.reason,
        evidence: verdict.evidence,
      });

      if (diverged) {
        logger.warn(
          '[FedSync] cross-network identities are provably one person but already hold '
          + 'separate Oxy users; recorded for reconciliation rather than re-pointed',
          {
            actor: actor.externalId,
            identity,
            counterpart: candidate,
            counterpartActor: counterpart.uri,
            reason: verdict.reason,
          },
        );
        continue;
      }

      logger.info('[FedSync] cross-network identity equivalence proven; sharing one Oxy user', {
        actor: actor.externalId,
        identity,
        counterpart: candidate,
        counterpartActor: counterpart.uri,
        reason: verdict.reason,
        evidence: verdict.evidence.map((claim) => `${claim.kind}:${claim.source}`),
      });
      outcome = { adoptOxyUserId: counterpart.oxyUserId, counterpartIdentity: candidate };
    }

    await revokeUnprovenLinks(identity, proven, actor.externalId);
    return outcome;
  } catch (err) {
    logger.warn('[FedSync] cross-network identity reconciliation failed', {
      actor: actor.externalId,
      err,
    });
    return NOT_APPLICABLE;
  }
}

/**
 * Withdraw every link this identity holds that the current evidence no longer
 * proves.
 *
 * THE REVERSAL PATH, and it runs on the ordinary refresh rather than on a
 * separate sweep. A link only ever rested on what both actors published; when
 * one of them stops publishing it — an account unlinked upstream, a handle
 * released and re-registered by somebody else — the pass that re-reads its
 * claims is exactly the pass that should take the link down.
 *
 * The row is kept, marked `revoked`, with its evidence snapshot intact: the
 * question somebody asks afterwards is "why were these two ever one person?",
 * and deleting the row is deleting the answer.
 */
async function revokeUnprovenLinks(
  identity: string,
  proven: ReadonlySet<string>,
  actorUri: string,
): Promise<void> {
  const existing = await findIdentityLinksFor(identity);
  for (const link of existing) {
    if (link.status === 'revoked') continue;
    const counterpart = link.identityA === identity ? link.identityB : link.identityA;
    if (proven.has(counterpart)) continue;

    // The snapshot the link was DECIDED on survives the revocation — see the doc
    // above. `recordIdentityLink` REPLACES the evidence rows, so it is read back
    // and passed through; writing `[]` here would revoke the link and delete the
    // answer to the only question a revoked link is ever asked.
    // eslint-disable-next-line no-await-in-loop
    const evidence = await loadIdentityLinkEvidence(link.id);
    // eslint-disable-next-line no-await-in-loop
    await recordIdentityLink({
      identityA: link.identityA,
      identityB: link.identityB,
      actorUriA: link.actorUriA,
      actorUriB: link.actorUriB,
      status: 'revoked',
      reason: link.reason,
      revokedReason: 'evidence-withdrawn',
      evidence,
    });
    logger.info('[FedSync] cross-network identity link revoked; the evidence is gone', {
      actor: actorUri,
      identity,
      counterpart,
    });
  }
}
