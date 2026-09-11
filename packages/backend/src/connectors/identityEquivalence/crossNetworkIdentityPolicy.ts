import { FEDERATION_NETWORKS, canonicalFederationHost } from '@oxy.so/federation';
import { THREADS_NETWORK } from './threadsNetwork';

/**
 * WHICH TWO NETWORKS MAY DESCRIBE ONE PERSON, AND WHAT IT TAKES TO PROVE IT.
 *
 * `resolveFederatedActorIdentity` merges copies of an account ACROSS a network
 * and never between two: `('x','nate')` and `('instagram','nate')` are unrelated
 * strings that happen to match, and merging them would be impersonation. That
 * default is correct and this file does not weaken it. Handle equality still
 * proves nothing, anywhere, ever.
 *
 * What it adds is a narrow, reviewed exception with a completely different
 * shape. Some pairs of networks are run by one operator on top of ONE account
 * system — Threads was launched on Instagram identity, and Meta continues to
 * operate cross-app account management between them — so `@zuck@instagram.com`
 * and `@zuck@threads.net` CAN be one person rather than two people who picked
 * the same word. Not "are": can. The pair being listed here is permission to
 * look for evidence, never evidence in itself.
 *
 * THIS IS A POLICY FILE, AND IT IS MENTION'S
 *
 *   Same discipline as `../activitypub/federationBridgePolicy` and
 *   `../activitypub/federationBlockPolicy`: committed, reviewed, reasons written
 *   down, git as the audit trail. Deciding that two networks share an account
 *   system is a judgement about two companies' products, not a protocol fact, so
 *   it does not belong in `@oxy.so/federation` where every Oxy app would inherit
 *   a call its owners never made.
 *
 * A WRONG ENTRY HERE IS AN ACCOUNT TAKEOVER, NOT A MISLABEL
 *
 *   A wrong bridge entry publishes one person's writing under another person's
 *   name. A wrong entry HERE hands one person's Mention profile — their
 *   followers, their posts, their identity — to whoever holds the same handle on
 *   the paired network. So the bar is not "these two products look related". It
 *   is: the operator runs one account system across both, AND we require
 *   evidence from the accounts themselves before anything merges.
 *
 * WHAT IS DELIBERATELY NOT LISTED
 *
 *   `instagram.com` ↔ `x.com`, or any other pair of networks run by different
 *   companies. There is no account system to share, so a match between them is
 *   two strangers and nothing can make it otherwise.
 *
 *   A network paired with ITSELF. That is the within-network merge, which
 *   `resolveFederatedActorIdentity` already does on the `<handle>@<network>` key
 *   without asking anybody's permission, because an upstream handle is globally
 *   unique on its own network.
 *
 * NOTE ON TRANSPORT
 *
 *   The networks named here are IDENTITY domains, never bridge hosts. An
 *   Instagram account reaches us through `kilogram.makeup` and is stored under
 *   `instagram.com`; a Threads account is native first-party ActivityPub and is
 *   stored under `threads.net`, which is why `threads.net` is not in the bridge
 *   policy and must never be added to it. The pair below is about the two
 *   IDENTITIES, and the transport each arrived over is irrelevant to it.
 */

/**
 * How much evidence a pair demands before two identities may share one Oxy user.
 *
 *  - `first-party`             the operator itself states the linkage, through a
 *                              first-party interface or a stable cross-app
 *                              account identifier. Sufficient on its own.
 *  - `bidirectional-assertion` each identity independently asserts the other,
 *                              machine-readably, on the actor. Neither half
 *                              alone is enough — a one-way link is a claim
 *                              anybody can publish about anybody.
 */
export type CrossNetworkEvidenceBar = 'first-party' | 'bidirectional-assertion';

/** One reviewed pair of networks that may describe one person. */
export interface CrossNetworkIdentityPair {
  /**
   * The two identity domains, CANONICAL and sorted — sorting is what makes a
   * pair one entry rather than two orderings of the same decision.
   */
  readonly networks: readonly [string, string];
  /** Who runs both, in one phrase, for review output and logs. */
  readonly operator: string;
  /** What it takes. See {@link CrossNetworkEvidenceBar}. */
  readonly requiredEvidence: CrossNetworkEvidenceBar;
  /**
   * Whether a handle on these networks identifies one person over time.
   *
   * `recyclable` means a released handle can be re-registered by somebody else,
   * so a proven link must be re-proved from CURRENTLY published evidence rather
   * than trusted because it was once established. Instagram releases abandoned
   * handles, the same residual the bridge policy records for X and Instagram.
   */
  readonly handleStability: 'stable' | 'recyclable';
  /** What was VERIFIED, as opposed to assumed. */
  readonly evidence: string;
  /** What is merely assumed, stated so a reviewer can attack it. */
  readonly assumption: string;
  /** `YYYY-MM-DD` — the day this entry was reviewed. */
  readonly since: string;
}

/** THE COMMITTED CROSS-NETWORK IDENTITY POLICY. */
export const CROSS_NETWORK_IDENTITY_POLICY: readonly CrossNetworkIdentityPair[] = [
  {
    networks: [FEDERATION_NETWORKS.instagram.domain, THREADS_NETWORK.domain],
    operator: 'Meta',
    requiredEvidence: 'bidirectional-assertion',
    handleStability: 'recyclable',
    evidence:
      'Threads launched on Instagram identity — users signed in with Instagram, and the Instagram '
      + 'username and verification carried over — and Meta operates the two as connected products '
      + 'with cross-app account management. So a shared underlying account is a real relationship '
      + 'between these two networks rather than a coincidence of naming, which is what qualifies the '
      + 'PAIR. `threads.net` is native first-party ActivityPub: `acct:zuck@threads.net` webfingers to '
      + 'a threads.net actor (verified 2026-09-11, returning '
      + 'https://threads.net/ap/users/17841401746480004/), so it is an identity domain here and must '
      + 'never be added to the bridge policy.'
      + ' WHAT WAS NOT VERIFIED, AND WHY THE BAR IS WHERE IT IS: threads.net serves its actor '
      + 'documents only to signed requests, so no live Threads actor was captured while writing this '
      + 'entry and NOTHING is claimed here about what assertion such an actor publishes. The '
      + 'evidence bar is therefore set on what the mechanism can check rather than on a shape '
      + 'somebody remembered — if neither side asserts the other, nothing merges, which is the '
      + 'correct outcome and the one this path produces today.',
    assumption:
      'That a shared Meta account system still implies a shared PERSON at the moment of the merge. '
      + "Meta's 2026 account direction lets one user keep different Meta Accounts for different apps, "
      + 'so the relationship is looser than it was at launch — which is exactly why the pair alone '
      + 'authorizes nothing and the per-account assertion decides.',
    since: '2026-09-11',
  },
];

/** A pair as the readers hand it back, with the two networks already ordered. */
export interface CrossNetworkPairLookup {
  readonly pair: CrossNetworkIdentityPair;
}

function canonicalPair(a: string, b: string): [string, string] {
  const left = canonicalFederationHost(a);
  const right = canonicalFederationHost(b);
  return left <= right ? [left, right] : [right, left];
}

/** Every identity domain that appears in ANY reviewed pair. */
const PARTICIPATING_DOMAINS: ReadonlySet<string> = new Set(
  CROSS_NETWORK_IDENTITY_POLICY.flatMap((entry) => entry.networks.map(canonicalFederationHost)),
);

const BY_PAIR_KEY: ReadonlyMap<string, CrossNetworkIdentityPair> = new Map(
  CROSS_NETWORK_IDENTITY_POLICY.map((entry) => [
    canonicalPair(entry.networks[0], entry.networks[1]).join('|'),
    entry,
  ]),
);

/**
 * Whether an identity domain takes part in any reviewed pair.
 *
 * THE GATE THAT KEEPS THIS OFF THE HOT PATH. Every actor of every ordinary
 * instance answers `false` from an in-memory set lookup and never touches the
 * claim tables — which matters, because the equivalence search costs reads and
 * the overwhelming majority of actors can never be part of one. Same shape as
 * the bridge relabeller's `findBridge`: a host nobody reviewed does nothing.
 */
export function participatesInCrossNetworkIdentity(identityDomain: string): boolean {
  return PARTICIPATING_DOMAINS.has(canonicalFederationHost(identityDomain));
}

/**
 * The reviewed pair covering these two identity domains, or `undefined`.
 *
 * `undefined` for two domains nobody paired, for a domain paired with itself
 * (the within-network merge, which is not this layer's business), and for
 * anything not canonically spelled — all of which must fail closed.
 */
export function findCrossNetworkPair(
  domainA: string,
  domainB: string,
): CrossNetworkIdentityPair | undefined {
  const [left, right] = canonicalPair(domainA, domainB);
  if (left === right) return undefined;
  return BY_PAIR_KEY.get(`${left}|${right}`);
}

/**
 * The stable key for a linked pair of identities, independent of which side was
 * ingested first.
 *
 * Arrival order must never decide what a row means: whichever of the two actors
 * reaches us first, the link they produce has to be the SAME row, or the second
 * ingest writes a duplicate that the first would never find. Lowercased and
 * sorted, so `(instagram, threads)` and `(threads, instagram)` are one key.
 */
export function identityPairKey(identityA: string, identityB: string): [string, string] {
  const left = identityA.trim().toLowerCase();
  const right = identityB.trim().toLowerCase();
  return left <= right ? [left, right] : [right, left];
}

/** The identity domain of a `<handle>@<domain>` identity, canonical, or `''`. */
export function identityDomainOf(federatedUsername: string): string {
  const at = federatedUsername.lastIndexOf('@');
  if (at <= 0 || at === federatedUsername.length - 1) return '';
  return canonicalFederationHost(federatedUsername.slice(at + 1));
}
