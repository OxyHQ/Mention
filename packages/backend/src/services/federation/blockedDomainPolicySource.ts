/**
 * The SINGLE seam between the committed blocklist policy and the automatic
 * purge.
 *
 * The policy file, its shape and its parser belong to the transparency work that
 * makes the blocklist a committed, publicly-explained artefact. This module owns
 * no parsing of its own: a second reader would be a second source of truth about
 * which domains are blocked, and the two would drift exactly when it mattered.
 * It calls `getBlockedDomainPolicy()` — the same function the public
 * transparency page's output is derived from — so what gets purged and what gets
 * published cannot disagree.
 *
 * `FEDERATION_BLOCKED_DOMAINS` is NOT reachable from here, and that is the
 * point. The env var stays an additive emergency lever that stops new content
 * immediately, but it can be changed by one person in a console with no diff, no
 * author and no review, so it must never drive unattended irreversible deletion.
 * The boundary is structural rather than a filter someone has to remember:
 * `getBlockedDomainPolicy()` returns reviewed entries only and has no parameter
 * through which an environment value can arrive. The MERGED view
 * (`resolveFederationBlocks`, which does include the lever) is what enforcement
 * and the page read; it is deliberately not what this reads. So an emergency env
 * block protects the instance the instant it is set, and the way to also remove
 * that domain's history is to write the entry up and commit it.
 *
 * `since` is deliberately unused for deciding what is new. It is a date the
 * policy AUTHOR declares, not a commit timestamp: it can be backdated, and
 * correcting a typo in it is an ordinary edit that must not re-trigger a
 * deletion. Whether a domain is newly blocked is decided by diffing the domain
 * set against the ledger of what has already been acted on — see
 * {@link ../BlockedDomainPurgeReconciler}. `reason` and `corroboratingSources`
 * ARE carried through, onto the purge's audit record, so the published
 * justification and the record of what was deleted for it are the same words.
 */

import {
  getBlockedDomainPolicy,
  type FederationBlockPolicyEntry,
} from '../../connectors/activitypub/federationBlockPolicy';

/** The reviewed, canonicalised policy entries currently in force. */
export type BlockedDomainPolicy = readonly FederationBlockPolicyEntry[];

export function loadBlockedDomainPolicy(): BlockedDomainPolicy {
  return getBlockedDomainPolicy();
}
