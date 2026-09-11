import {
  findCrossNetworkPair,
  identityDomainOf,
  type CrossNetworkIdentityPair,
} from './crossNetworkIdentityPolicy';
import type { CrossNetworkIdentityClaim, IdentityClaimKind } from './identityClaims';

/**
 * DECIDING WHETHER TWO IDENTITIES ARE ONE PERSON — AND SAYING WHY, EITHER WAY.
 *
 * Pure. It is handed a reviewed pair and the claims each side publishes, and it
 * returns a verdict carrying the claims that decided it. No database, no
 * network, no clock: the whole point is that the reasoning can be replayed from
 * stored evidence when somebody asks "why are these two accounts one person?" —
 * and that the answer is the same every time it is asked.
 *
 * IT REFUSES BY DEFAULT AND SAYS WHAT WAS MISSING
 *
 *   A refusal is the common outcome and carries a machine-readable `reason`, so
 *   the reconciliation report can distinguish "no claims at all" from "one side
 *   asserts and the other does not" — the second is an account halfway through
 *   linking, the first is two strangers, and treating them alike would make the
 *   report useless.
 *
 * WHY ONE-WAY IS NOT ENOUGH
 *
 *   Anybody can publish `alsoKnownAs: https://www.instagram.com/zuck`. What
 *   nobody but Zuckerberg can do is make the Instagram account point back. So a
 *   `bidirectional-assertion` pair needs a claim in EACH direction, each read
 *   off its own actor, and neither half alone moves anything. That is the one
 *   property that makes a machine-readable alias safe to act on, and it is why
 *   the bar is not simply "a link exists".
 *
 *   `first-party-link` is exempt because its author is the operator of both
 *   networks rather than either account: it is not one account vouching for
 *   another, it is the account system stating that these are one entry in it.
 */

/** Why a pair was or was not linked. Stable strings — logs and reports read them. */
export type EquivalenceReason =
  /** Linked: the operator states the linkage. */
  | 'first-party-link'
  /** Linked: each identity independently asserts the other. */
  | 'bidirectional-assertion'
  /** Refused: the two networks are not a reviewed pair. */
  | 'pair-not-reviewed'
  /** Refused: neither side says anything about the other. */
  | 'no-claims'
  /** Refused: one side asserts the other, and the other is silent. */
  | 'one-way-claim-only';

/** What {@link evaluateEquivalence} decided, and the evidence it decided on. */
export interface EquivalenceVerdict {
  readonly linked: boolean;
  readonly reason: EquivalenceReason;
  /**
   * The claims that carried the verdict — EMPTY on a refusal with nothing to
   * show, and the one-way claim on `one-way-claim-only`, because a report that
   * cannot name the half it has is not auditable.
   */
  readonly evidence: readonly CrossNetworkIdentityClaim[];
}

/** Claims published by one side, already read off that side's own actor. */
export interface EquivalenceSide {
  /** `<handle>@<network-domain>`. */
  readonly identity: string;
  readonly claims: readonly CrossNetworkIdentityClaim[];
}

const FIRST_PARTY: IdentityClaimKind = 'first-party-link';

/** The claims one side makes about the other, ignoring anything aimed elsewhere. */
function claimsAbout(side: EquivalenceSide, other: string): CrossNetworkIdentityClaim[] {
  const target = other.trim().toLowerCase();
  return side.claims.filter(
    (claim) =>
      claim.target.trim().toLowerCase() === target
      && claim.subject.trim().toLowerCase() === side.identity.trim().toLowerCase(),
  );
}

/**
 * Whether two identities may share one Oxy user, given what each publishes.
 *
 * The pair is looked up from the two identities' NETWORKS rather than passed in,
 * so a caller cannot hand this an unreviewed pair by mistake — an unreviewed
 * pair, a malformed identity and a network paired with itself all land on
 * `pair-not-reviewed` and link nothing.
 */
export function evaluateEquivalence(
  a: EquivalenceSide,
  b: EquivalenceSide,
): EquivalenceVerdict & { pair?: CrossNetworkIdentityPair } {
  const domainA = identityDomainOf(a.identity);
  const domainB = identityDomainOf(b.identity);
  const pair = domainA && domainB ? findCrossNetworkPair(domainA, domainB) : undefined;
  if (!pair) return { linked: false, reason: 'pair-not-reviewed', evidence: [] };

  const aboutB = claimsAbout(a, b.identity);
  const aboutA = claimsAbout(b, a.identity);

  // A first-party statement is the operator's, not either account's, so it
  // stands alone — and it stands alone even on a pair whose bar is the stricter
  // `bidirectional-assertion`, because that bar exists to substitute for an
  // authority neither account has and this claim IS that authority.
  const firstParty = [...aboutB, ...aboutA].filter((claim) => claim.kind === FIRST_PARTY);
  if (firstParty.length > 0) {
    return { linked: true, reason: 'first-party-link', evidence: firstParty, pair };
  }

  if (pair.requiredEvidence === 'first-party') {
    const held = [...aboutB, ...aboutA];
    return {
      linked: false,
      reason: held.length > 0 ? 'one-way-claim-only' : 'no-claims',
      evidence: held,
      pair,
    };
  }

  if (aboutB.length > 0 && aboutA.length > 0) {
    return {
      linked: true,
      reason: 'bidirectional-assertion',
      evidence: [...aboutB, ...aboutA],
      pair,
    };
  }

  const held = [...aboutB, ...aboutA];
  return {
    linked: false,
    reason: held.length > 0 ? 'one-way-claim-only' : 'no-claims',
    evidence: held,
    pair,
  };
}
