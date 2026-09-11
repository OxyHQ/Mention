import { federatedUsernameFromUpstreamUrl } from '@oxy.so/federation';
import { CLAIMABLE_NETWORKS } from './threadsNetwork';
import { identityDomainOf, participatesInCrossNetworkIdentity } from './crossNetworkIdentityPolicy';

/**
 * READING, OUT OF AN ACTOR, WHAT IT CLAIMS TO ALSO BE ON ANOTHER NETWORK.
 *
 * This module turns an actor document into CLAIMS and does nothing else with
 * them. It never decides that two accounts are one person — that is
 * `./equivalenceEvidence`, given claims from BOTH sides — and it never looks at
 * a username, a display name, an avatar, a bio or a verification badge, because
 * none of those is an assertion about identity. Somebody else having your name
 * is not a statement by you.
 *
 * A CLAIM IS SOMETHING AN ACCOUNT SAYS, IN A FIELD MEANT FOR SAYING IT
 *
 *   Two shapes qualify, and they are the two ActivityPub already has:
 *
 *     `alsoKnownAs`   the migration/alias field, machine-readable by definition.
 *     a VERIFIED `rel="me"` profile link
 *                     a link the REMOTE INSTANCE checked, by fetching the target
 *                     and finding a link back. `verifiedAt` is what records that
 *                     check, and an unverified link is only a URL somebody
 *                     typed — anybody can put `instagram.com/zuck` in their bio.
 *
 *   Both are one-way and neither is proof on its own. What this produces is
 *   evidence to be weighed, not a verdict.
 *
 * A CLAIM ONLY COUNTS WHEN IT CROSSES A REVIEWED PAIR
 *
 *   A claim pointing at a network nobody paired with this one is dropped here
 *   rather than stored and ignored later. That keeps the claim tables to the
 *   accounts the policy can actually act on, and means a new pair is a policy
 *   edit plus a re-ingest rather than a schema migration.
 *
 *   A claim pointing at the subject's OWN network is dropped too. A bridged
 *   Instagram actor's `Official` field is exactly that — `zuck@instagram.com`
 *   asserting `https://www.instagram.com/zuck`, which is itself — and it is the
 *   input the bridge relabeller already read to derive the identity. Reading it
 *   a second time as a cross-network claim would have an account vouch for
 *   itself.
 */

/**
 * What kind of statement carried a claim. Ordered by strength, and the order is
 * load-bearing: `./equivalenceEvidence` compares against a pair's required bar.
 *
 *  - `first-party-link`      the network OPERATOR states the linkage — a stable
 *                            cross-app account identifier, or an approved
 *                            first-party interface. Not derived from an actor
 *                            document; supplied by an attested source.
 *  - `also-known-as`         the actor's own `alsoKnownAs`.
 *  - `verified-profile-link` a profile field the remote instance verified.
 */
export type IdentityClaimKind = 'first-party-link' | 'also-known-as' | 'verified-profile-link';

/** One account saying, machine-readably, that it is also an account elsewhere. */
export interface CrossNetworkIdentityClaim {
  /** The identity making the claim, as `<handle>@<network-domain>`. */
  readonly subject: string;
  /** The protocol id of the actor the claim was read off — the claim's provenance. */
  readonly subjectActorUri: string;
  /** The identity being claimed, as `<handle>@<network-domain>`. */
  readonly target: string;
  readonly kind: IdentityClaimKind;
  /** The literal value asserted, kept verbatim so a merge can be explained later. */
  readonly source: string;
}

/** An actor profile field, as the actor cache stores it. */
export interface ActorProfileField {
  readonly name: string;
  readonly value: string;
  /** Set when the REMOTE instance verified the `rel="me"` link. */
  readonly verifiedAt?: Date;
}

/** Everything {@link readCrossNetworkIdentityClaims} looks at. */
export interface IdentityClaimSource {
  /** The identity this actor is stored under (`zuck@instagram.com`). */
  readonly federatedUsername: string;
  /** The actor's protocol id. */
  readonly actorUri: string;
  readonly alsoKnownAs?: readonly string[];
  readonly fields?: readonly ActorProfileField[];
}

/** The `href` of the first anchor in a profile-field value, or `undefined`. */
function firstHref(fieldValue: string): string | undefined {
  const match = /<a\b[^>]*\bhref=["']([^"']+)["']/i.exec(fieldValue);
  return match?.[1];
}

/**
 * Whether a profile field's anchor carries `rel="me"`.
 *
 * Checked ALONGSIDE `verifiedAt` rather than instead of it. `rel="me"` is what
 * the author asked for; `verifiedAt` is what the remote instance actually
 * checked. A field carrying one without the other is not a verified identity
 * assertion, so both are required.
 */
function assertsRelMe(fieldValue: string): boolean {
  const match = /<a\b[^>]*\brel=["']([^"']*)["']/i.exec(fieldValue);
  if (!match) return false;
  return match[1].split(/\s+/).some((token) => token.toLowerCase() === 'me');
}

/**
 * The `<handle>@<network>` identity a URL names, when it is a profile URL on a
 * network that takes part in some reviewed pair — otherwise `undefined`.
 *
 * Routed through `federatedUsernameFromUpstreamUrl`, the SAME declaration the
 * ingest and the pasted-link search read, so a claim and the row it would link
 * to cannot be spelled differently. A second, parallel URL parser here would
 * work for Instagram (where the rule is just lowercasing) and quietly fail for
 * Bluesky (where a default handle's suffix is dropped), producing claims that
 * match nothing — a failure that looks exactly like "no evidence exists".
 */
function claimedIdentity(candidateUrl: string): string | undefined {
  const identity = federatedUsernameFromUpstreamUrl(candidateUrl, CLAIMABLE_NETWORKS);
  if (identity === undefined) return undefined;
  return participatesInCrossNetworkIdentity(identityDomainOf(identity)) ? identity : undefined;
}

/**
 * Every cross-network claim an actor publishes about itself.
 *
 * Returns `[]` for the overwhelming majority of actors, which is the correct
 * answer and the one that keeps the rest of this layer inert. Duplicates are
 * collapsed on `(target, kind)` — a profile listing the same link twice is one
 * statement, and counting it twice would let one side manufacture the
 * appearance of corroboration.
 */
export function readCrossNetworkIdentityClaims(
  actor: IdentityClaimSource,
): CrossNetworkIdentityClaim[] {
  const subject = actor.federatedUsername.trim().toLowerCase();
  const subjectDomain = identityDomainOf(subject);
  if (subjectDomain.length === 0) return [];

  const claims = new Map<string, CrossNetworkIdentityClaim>();

  const add = (target: string, kind: IdentityClaimKind, source: string): void => {
    // Self-claims and same-network claims are not this layer's business — see
    // the module doc. Dropped at the point of reading so nothing downstream has
    // to remember the rule.
    if (target === subject) return;
    if (identityDomainOf(target) === subjectDomain) return;
    const key = `${target}|${kind}`;
    if (!claims.has(key)) {
      claims.set(key, { subject, subjectActorUri: actor.actorUri, target, kind, source });
    }
  };

  for (const alias of actor.alsoKnownAs ?? []) {
    if (typeof alias !== 'string') continue;
    const target = claimedIdentity(alias);
    if (target) add(target, 'also-known-as', alias.trim());
  }

  for (const field of actor.fields ?? []) {
    if (!field.verifiedAt) continue;
    if (!assertsRelMe(field.value)) continue;
    const href = firstHref(field.value);
    if (!href) continue;
    const target = claimedIdentity(href);
    if (target) add(target, 'verified-profile-link', href.trim());
  }

  return [...claims.values()];
}
