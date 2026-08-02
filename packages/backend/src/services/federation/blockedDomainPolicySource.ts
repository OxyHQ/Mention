/**
 * The SINGLE seam between the committed blocklist policy and the automatic
 * purge.
 *
 * The policy file itself — its path, its shape and its parser — is owned by the
 * transparency work that makes the blocklist a committed, publicly-explained
 * artefact. This module deliberately does NOT read or parse it: a second parser
 * would be a second source of truth about which domains are blocked, and the two
 * would drift exactly when it mattered. When that parser lands, this function
 * becomes a one-line delegation to it.
 *
 * Until then it returns `null`, which the reconciler treats as "no policy source
 * — do nothing". That is the correct behaviour, not a placeholder: the automatic
 * trigger is defined to key off the reviewed, committed file, so with no such
 * file there is nothing for it to react to and it must stay inert.
 *
 * `FEDERATION_BLOCKED_DOMAINS` is NOT consulted here, and that is the point.
 * The env var remains an additive emergency lever that stops new content
 * immediately, but it can be changed by one person in a console with no diff, no
 * author and no review. Unattended irreversible deletion is driven only by the
 * artefact that carries all three. An emergency env block still protects the
 * instance the moment it is set; it simply does not also delete history until
 * the domain is committed to the policy.
 */

/** Canonical domains the committed policy currently blocks, or `null` if none is available. */
export type BlockedDomainPolicy = readonly string[] | null;

export function loadBlockedDomainPolicy(): BlockedDomainPolicy {
  return null;
}
