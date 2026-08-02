/**
 * The circuit breaker for the AUTOMATIC blocked-domain purge.
 *
 * WHY THIS EXISTS
 *   Making the purge automatic turns the blocklist into a loaded gun. A typo in
 *   the policy file — a lookalike domain, a stray character, a bad paste —
 *   irreversibly deletes legitimate content the moment it deploys, with no
 *   review window and no undo. That failure is far worse than the problem
 *   automation solves, so the automatic path is allowed to run unattended ONLY
 *   while the blast radius looks ordinary. Anything unusual refuses and waits
 *   for a human, exactly as the destructive script already refuses without
 *   `CONFIRM_ADMIN_MUTATION`.
 *
 * WHAT IT MEASURES, AND WHY THESE SIGNALS
 *   The useful question is not "is this a lot of content" but "does this look
 *   like an instance real people here are engaged with". So the primary signal
 *   is LOCAL ENGAGEMENT, not size:
 *
 *   - `localFollowsRemoved` is the sharpest discriminator available. Measured
 *     across all 196 corroborated blocklist domains in production it is ZERO:
 *     nobody here follows anyone on any of them. A typo'd `mastodon.social`
 *     would not be zero. So the ceiling is zero, and it is a HARD one — any
 *     local user having chosen to follow an account there is reason enough for
 *     a person to look before we delete it.
 *   - `repliesByOthersKept` + `quotesByOthersKept` + `threadRootsKept` count
 *     local users whose own posts end up pointing at something removed. A domain
 *     our users are conversing with is not a spam host.
 *
 *   Size is the backstop, expressed as a SHARE of the corpus rather than a fixed
 *   count. An absolute ceiling tuned on today's numbers silently becomes either
 *   meaningless or unreachable as the corpus grows — the same reasoning
 *   `AdminRunTolerance` already applies to sweep failure rates. Absolute floors
 *   exist only so a small corpus does not trip on noise.
 *
 * WHAT A BREACH DOES
 *   It does NOT fail the deploy and does NOT delete anything: the batch is
 *   recorded as held, with the breached ceiling and the measured numbers, for a
 *   human to review and then run the one-shot explicitly. Failing to delete is
 *   the safe direction; deleting wrongly is not.
 */

/** One ceiling, with the argument for it required to sit next to the number. */
export interface PurgeCeiling {
  /**
   * Inclusive maximum share of the corpus. `0` means the ceiling is absolute:
   * any count above `alwaysAllowBelow` breaches it whatever the corpus size.
   */
  maxFraction: number;
  /**
   * Counts at or below this always pass, whatever the corpus. A share of a tiny
   * corpus is noise, and a purge of a handful of documents is never the failure
   * this breaker exists to catch.
   */
  alwaysAllowBelow: number;
  /** Why this ceiling is where it is. REQUIRED — a number with no argument is a guess. */
  reason: string;
}

/** Which corpus a ceiling is a share OF. */
export type PurgeCeilingBasis = 'federatedPosts' | 'federatedActors';

export interface PurgeCeilingDefinition extends PurgeCeiling {
  basis: PurgeCeilingBasis;
  /** Whether the count is measured for ONE domain or across the whole batch. */
  scope: 'per-domain' | 'total';
}

/**
 * The ceilings, in one place, each with its reasoning.
 *
 * Numbers anchored on the production measurement that motivated this work: 196
 * corroborated domains holding 6,401 posts and 1,135 actors, zero local follows,
 * with the single largest domain about 1,440 posts.
 */
export const AUTOMATIC_PURGE_CEILINGS = {
  localFollowsPerDomain: {
    basis: 'federatedActors',
    scope: 'per-domain',
    maxFraction: 0,
    alwaysAllowBelow: 0,
    reason:
      'A local user chose to follow an account there. Zero across all 196 measured '
      + 'blocklist domains, so any non-zero value is the shape of a mistake, not of a '
      + 'spam host — a person looks before this is deleted.',
  },
  localContentPerDomain: {
    basis: 'federatedPosts',
    scope: 'per-domain',
    maxFraction: 0.01,
    alwaysAllowBelow: 50,
    reason:
      'Local posts left pointing at removed content (replies, quotes, thread roots). '
      + 'A domain our own users are conversing with at scale is not a spam host, and '
      + 'each one is a real post that degrades.',
  },
  postsPerDomain: {
    basis: 'federatedPosts',
    scope: 'per-domain',
    maxFraction: 0.05,
    alwaysAllowBelow: 2_000,
    reason:
      'A single domain being more than a twentieth of everything we hold is the shape '
      + 'of a major instance, not of one spam host; the largest real blocklist domain '
      + 'measured about 1,440 posts.',
  },
  actorsPerDomain: {
    basis: 'federatedActors',
    scope: 'per-domain',
    maxFraction: 0.05,
    alwaysAllowBelow: 500,
    reason:
      'Same reasoning as posts, on the identity side: all 196 measured domains held '
      + '1,135 actors between them.',
  },
  postsTotal: {
    basis: 'federatedPosts',
    scope: 'total',
    maxFraction: 0.2,
    alwaysAllowBelow: 2_000,
    reason:
      'A batch ceiling as well as a per-domain one, so many individually-ordinary '
      + 'domains added at once cannot remove a fifth of the corpus unattended.',
  },
  actorsTotal: {
    basis: 'federatedActors',
    scope: 'total',
    maxFraction: 0.2,
    alwaysAllowBelow: 500,
    reason: 'The identity-side batch ceiling, matching postsTotal.',
  },
} as const satisfies Record<string, PurgeCeilingDefinition>;

export type PurgeCeilingName = keyof typeof AUTOMATIC_PURGE_CEILINGS;

/** The measured blast radius a decision is made from. */
export interface PurgeMeasurement {
  corpus: { federatedPosts: number; federatedActors: number };
  /** Batch-wide counts. */
  total: { posts: number; actors: number };
  /** Per-domain counts, keyed by canonical domain. */
  perDomain: ReadonlyMap<string, {
    posts: number;
    actors: number;
    localFollows: number;
    localContent: number;
  }>;
}

/** One ceiling that refused. */
export interface PurgeCeilingBreach {
  ceiling: PurgeCeilingName;
  /** The domain responsible, or `null` for a batch-wide ceiling. */
  domain: string | null;
  observed: number;
  basisTotal: number;
  limit: string;
  reason: string;
}

/** Human-readable form of the limit a count was measured against. */
function describeLimit(ceiling: PurgeCeilingDefinition, basisTotal: number): string {
  if (ceiling.maxFraction <= 0) {
    return `at most ${ceiling.alwaysAllowBelow} (absolute)`;
  }
  const share = Math.floor(basisTotal * ceiling.maxFraction);
  return `at most ${Math.max(ceiling.alwaysAllowBelow, share)} `
    + `(${(ceiling.maxFraction * 100).toFixed(0)}% of ${basisTotal}, floor ${ceiling.alwaysAllowBelow})`;
}

/** Whether one count clears one ceiling. */
function clears(ceiling: PurgeCeilingDefinition, observed: number, basisTotal: number): boolean {
  if (observed <= ceiling.alwaysAllowBelow) return true;
  if (ceiling.maxFraction <= 0) return false;
  // A share of nothing is undefined, so a positive count against an empty corpus
  // can never be "a small fraction" — it breaches, rather than dividing by zero
  // into a pass.
  if (basisTotal <= 0) return false;
  return observed / basisTotal <= ceiling.maxFraction;
}

/**
 * Evaluate every ceiling and return EVERY breach, not just the first.
 *
 * All of them, because a held batch is reviewed by a human once: giving them the
 * complete picture is the difference between one review and several.
 */
export function evaluatePurgeCeilings(
  measurement: PurgeMeasurement,
): PurgeCeilingBreach[] {
  const breaches: PurgeCeilingBreach[] = [];
  const basisOf = (basis: PurgeCeilingBasis): number =>
    basis === 'federatedPosts'
      ? measurement.corpus.federatedPosts
      : measurement.corpus.federatedActors;

  const check = (
    name: PurgeCeilingName,
    domain: string | null,
    observed: number,
  ): void => {
    const ceiling: PurgeCeilingDefinition = AUTOMATIC_PURGE_CEILINGS[name];
    const basisTotal = basisOf(ceiling.basis);
    if (clears(ceiling, observed, basisTotal)) return;
    breaches.push({
      ceiling: name,
      domain,
      observed,
      basisTotal,
      limit: describeLimit(ceiling, basisTotal),
      reason: ceiling.reason,
    });
  };

  check('postsTotal', null, measurement.total.posts);
  check('actorsTotal', null, measurement.total.actors);

  // Sorted so a held batch reports its domains in a stable order across runs —
  // a review that reads differently each time is a review nobody trusts.
  for (const domain of [...measurement.perDomain.keys()].sort()) {
    const counts = measurement.perDomain.get(domain);
    if (!counts) continue;
    check('localFollowsPerDomain', domain, counts.localFollows);
    check('localContentPerDomain', domain, counts.localContent);
    check('postsPerDomain', domain, counts.posts);
    check('actorsPerDomain', domain, counts.actors);
  }

  return breaches;
}

/** A one-line summary of why a batch was held, for the ledger and the log. */
export function describeBreaches(breaches: readonly PurgeCeilingBreach[]): string {
  return breaches
    .map((breach) =>
      `${breach.ceiling}${breach.domain ? `(${breach.domain})` : ''}=${breach.observed} > ${breach.limit}`)
    .join('; ');
}
