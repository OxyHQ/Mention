/**
 * Federation types for ActivityPub/Mastodon integration
 */

export interface FederatedActorField {
  name: string;
  value: string;
  verifiedAt?: string;
}

export interface FederatedActorProfile {
  actorUri: string;
  handle: string;
  instance: string;
  fullHandle: string;
  displayName: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  fields?: FederatedActorField[];
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  isFollowing?: boolean;
  isFollowPending?: boolean;
  discoverable?: boolean;
  memorial?: boolean;
  suspended?: boolean;
  createdAt?: string;
  type?: string;
}

export interface FederationFollowResponse {
  success: boolean;
  pending: boolean;
  actorUri: string;
}

export interface FederationUnfollowResponse {
  success: boolean;
  actorUri: string;
}

/**
 * How far a moderation decision goes.
 *
 * Deliberately a ONE-MEMBER union: it names only what Mention actually enforces.
 * `suspend` is the whole of it — the domain is refused everywhere the federation
 * policy is consulted, so nothing from it is fetched, accepted, stored or shown.
 *
 * Mastodon's vocabulary also has `silence` (federate, but keep out of public
 * timelines), and other instances publish blocks at that severity. Mention has no
 * mechanism for it, so it is not a member here: a page that advertised a severity
 * the server cannot apply would be exactly the drift this whole surface exists to
 * prevent. Adding `silence` means implementing it first.
 */
export type FederationBlockSeverity = 'suspend';

/**
 * Why a domain is refused, from a closed vocabulary.
 *
 * Closed on purpose. Every member has a human label on the public transparency
 * page, so a decision cannot be published under a reason nobody wrote copy for,
 * and the categories stay comparable to each other instead of drifting into
 * free-form editorialising. A genuinely new kind of reason is a code change —
 * which is the point: it gets reviewed.
 */
export type FederationBlockCategory =
  | 'child_safety'
  | 'hate_speech'
  | 'harassment'
  | 'spam'
  | 'malware'
  | 'unmoderated';

/**
 * One published moderation decision, as served to anyone who asks.
 *
 * Discriminated on `source`, because the two ways a domain gets blocked owe the
 * reader different things:
 *
 * - `policy` — a reviewed entry in the committed policy file. It carries the
 *   full account: what it is, why, since when, and who else independently
 *   published the same decision.
 * - `operational` — an urgent block applied through the `FEDERATION_BLOCKED_DOMAINS`
 *   environment lever, so it could take effect without waiting for a deploy. It
 *   has no published reason yet, and the page says so plainly rather than
 *   inventing one. Making that visible is deliberate: an undocumented block on a
 *   transparency page is a standing prompt to write it up properly.
 */
export type PublishedFederationBlock =
  | {
      source: 'policy';
      domain: string;
      severity: FederationBlockSeverity;
      category: FederationBlockCategory;
      /** One factual sentence, written for the public. */
      reason: string;
      /** `YYYY-MM-DD`, the day the decision took effect. */
      since: string;
      /**
       * Instances that had independently published the same decision when ours
       * was taken. Empty means it came from moderation on Mention itself rather
       * than from corroborating another instance — both are honest, and the page
       * distinguishes them.
       */
      corroboratingSources: readonly string[];
    }
  | {
      source: 'operational';
      domain: string;
      severity: FederationBlockSeverity;
    };

/** Response of `GET /federation/blocked-domains`. */
export interface FederationBlocksResponse {
  blocks: PublishedFederationBlock[];
}
