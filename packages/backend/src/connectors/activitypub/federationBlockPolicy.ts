import type {
  FederationBlockCategory,
  FederationBlockSeverity,
  PublishedFederationBlock,
} from '@mention/shared-types';

/**
 * WHICH INSTANCES MENTION REFUSES TO FEDERATE WITH, AND WHY.
 *
 * This file is the policy. Not a cache of one, not a mirror of one — the list
 * below is read by the enforcement predicate (`isBlockedDomain`) and by the
 * public transparency page, and there is no third copy anywhere.
 *
 * WHY THE LIST LIVES IN THE REPOSITORY RATHER THAN IN CONFIGURATION
 *
 *   A blocklist is not a secret. It is public moderation policy. Mastodon
 *   instances publish theirs at `GET /api/v1/instance/domain_blocks`, and that
 *   is precisely how our own intelligence script
 *   (`scripts/reportFederationBlocklistCandidates.ts`) learns which domains
 *   other instances have suspended. Reading everyone else's published policy
 *   while hiding our own would be taking without giving.
 *
 *   Keeping it here also makes the history real. Git records WHEN each domain
 *   was added and — in the commit message — the evidence it was added on. That
 *   is an audit trail somebody can review, dispute and revert. A comma-separated
 *   string in a deploy console that one person edited once, months ago, is not.
 *
 *   And it removes the failure mode a transparency page is most prone to: the
 *   page and the server disagreeing. Both read {@link resolveFederationBlocks};
 *   the enforcement set is derived from the very array the page renders, so a
 *   domain cannot be quietly blocked without being listed. Two sources would
 *   eventually make the page a lie.
 *
 * THE EMERGENCY LEVER STILL WORKS
 *
 *   `FEDERATION_BLOCKED_DOMAINS` (comma-separated env) is unioned into the same
 *   predicate, so an urgent block does not have to wait for a deploy. One
 *   authority, two inputs — never a second predicate. Such an entry is published
 *   too, as `source: 'operational'`, saying openly that its reason has not been
 *   written up yet. A block that nobody can see is the thing this file exists to
 *   prevent, and an undocumented one showing on the page is a standing prompt to
 *   move it down here properly.
 *
 * WHAT IS DELIBERATELY *NOT* PUBLISHED
 *
 *   `isBlockedDomain` also rejects our OWN ActivityPub domains and the Oxy
 *   identity apex. Those are not moderation decisions — both hosts publish our
 *   own users, and treating them as remote would duplicate local accounts. They
 *   are enforcement-only and must never appear on the transparency page; listing
 *   `mention.earth` among "instances we refuse" would be a straightforward
 *   falsehood. The published list therefore covers exactly the moderation
 *   inputs: this file, plus the environment lever.
 */

/**
 * One reviewed entry in the policy.
 *
 * `domain` must be written CANONICAL — lowercase, bare host, no scheme, no
 * `www.` prefix, no path — which is the form the federation engine compares
 * against. `resolveFederationBlocks` canonicalises anyway so a slip cannot
 * silently fail to block, and a test asserts every committed entry is already in
 * that form so the file reads exactly as it behaves.
 */
export interface FederationBlockPolicyEntry {
  readonly domain: string;
  readonly severity: FederationBlockSeverity;
  readonly category: FederationBlockCategory;
  /**
   * One factual sentence, written for the public and in the knowledge that the
   * people it describes will read it. State what was found. Do not characterise
   * a community beyond the finding, and do not gloat.
   */
  readonly reason: string;
  /** `YYYY-MM-DD` — the day the block took effect. */
  readonly since: string;
  /**
   * Instances that had ALREADY published the same decision, independently, when
   * ours was taken — the corroboration our intelligence script reports.
   *
   * Empty is legitimate and means the decision came from moderation on Mention
   * itself. It is never a placeholder for "did not check": leaving it empty
   * makes the page say the decision was ours alone, so an entry that WAS
   * corroborated must name its sources.
   */
  readonly corroboratingSources: readonly string[];
}

/**
 * The committed policy. Empty: Mention has not yet published a block.
 *
 * That emptiness is the honest current state, and the transparency page says so
 * in as many words rather than pretending to a moderation history we do not
 * have. Adding the first entry is a reviewed commit whose message carries the
 * evidence — for a corroborated domain, the run of
 * `scripts/reportFederationBlocklistCandidates.ts` it came from.
 *
 * @example
 * ```ts
 * {
 *   domain: 'example.invalid',
 *   severity: 'suspend',
 *   category: 'child_safety',
 *   reason: 'Hosts sexualised imagery of minors and does not act on reports.',
 *   since: '2026-08-02',
 *   corroboratingSources: ['mastodon.social', 'mstdn.social'],
 * }
 * ```
 */
export const FEDERATION_BLOCK_POLICY: readonly FederationBlockPolicyEntry[] = [];

/**
 * Canonical comparison form for a domain: trimmed, lowercased, `www.` stripped.
 *
 * Mirrors `canonicalDomainHost` inside `@oxyhq/federation`'s `createDomainPolicy`,
 * which is what actually compares an incoming host against the blocked set. The
 * two agreeing is not left to inspection — the enforcement test blocks a domain
 * through this module and asserts the ENGINE rejects it.
 *
 * Note what it does NOT do: it does not strip a trailing dot. `example.com.` is
 * a different string from `example.com` here and in the engine alike, so it
 * matches nothing — which is the safe outcome, and the committed policy's shape
 * gate rejects it anyway. Exported so that every consumer comparing a host
 * against this policy uses THIS function: a second canonicaliser that stripped
 * the dot would decide a host was blocked when the engine had not, and for a
 * consumer whose action is irreversible that difference is content deleted for a
 * domain we never actually blocked.
 *
 * This is a MIRROR, not the engine's own function. `@oxyhq/federation` keeps
 * `canonicalDomainHost` private (`apUri.ts` exports only
 * `extractActorUriFromActivityId`, `createDomainPolicy` and two types), so
 * exporting this removes the duplication INSIDE Mention and no further. Two
 * implementations still have to agree, and the engine's is the one that decides
 * what is refused at the wire. Nothing structural keeps them in step — only the
 * tests that drive the real `createDomainPolicy` and assert the same verdict.
 * Under the fix-upstream rule the resolution is for the engine to export
 * `canonicalDomainHost` and for this to be deleted, not for the copy to be
 * maintained.
 *
 * The two possible drifts are NOT equally dangerous, and the asymmetry is worth
 * knowing before anyone weighs that work. `createDomainPolicy` re-canonicalises
 * whatever domains it is handed, and `constants.ts` hands it this module's
 * output — so if the ENGINE later normalises more than this does, enforcement
 * widens while the purge does not, and we refuse content we have not deleted.
 * Inconsistent, but recoverable. The unrecoverable direction is the reverse: for
 * MENTION's copy to normalise more than the engine's, which makes the purge
 * delete content for a block that was never in force at the wire. That was a
 * real bug here — a trailing-dot strip — and it is now pinned by a test that
 * drives the engine rather than a fixture.
 */
export function canonicalBlockedDomain(domain: string): string {
  const value = domain.trim().toLowerCase();
  return value.startsWith('www.') ? value.slice(4) : value;
}

/**
 * THE COMMITTED POLICY, PARSED — the single reader of {@link FEDERATION_BLOCK_POLICY}.
 *
 * Domains come back canonicalised through {@link canonicalBlockedDomain} (so a
 * consumer never has to know the comparison form, and a slip in the file cannot
 * quietly produce a domain that matches nothing), deduplicated last-wins, and
 * sorted — the same treatment {@link resolveFederationBlocks} gives them, because
 * it is this function's output that it merges.
 *
 * Returns REVIEWED entries only. The `FEDERATION_BLOCKED_DOMAINS` environment
 * lever is deliberately absent: a committed entry has a diff, an author and a
 * review, an environment value has none of those. Any consumer whose action is
 * irreversible — deleting already-ingested content, say — should key off THIS,
 * not off the merged {@link resolveFederationBlocks} output, and the boundary is
 * enforced by the shape rather than left to a filter the caller has to remember.
 *
 * `since` is the day the block took effect AS DECLARED BY THE AUTHOR. It is not a
 * commit timestamp and is not guaranteed to move only forwards — a typo in it is
 * an ordinary correction. Do not use it to decide that a domain is NEWLY blocked;
 * diff the domain set against what you have already acted on.
 *
 * Call it with no arguments — the default IS the committed policy, and that is
 * the only source a consumer should be reading. `entries` exists so the parsing
 * can be tested against data while the committed list is empty; a test that
 * needs to swap the policy for a whole module graph should mock this function
 * instead (`__tests__/connectors/federationTransparency.test.ts` is the worked
 * example).
 */
export function getBlockedDomainPolicy(
  entries: readonly FederationBlockPolicyEntry[] = FEDERATION_BLOCK_POLICY,
): readonly FederationBlockPolicyEntry[] {
  const byDomain = new Map<string, FederationBlockPolicyEntry>();

  for (const entry of entries) {
    const domain = canonicalBlockedDomain(entry.domain);
    if (domain.length === 0) continue;
    byDomain.set(domain, { ...entry, domain });
  }

  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Merge the committed policy with the environment lever into the ONE list that
 * is both enforced and published.
 *
 * Deduplicated by canonical domain, with the committed entry winning: the same
 * domain in both inputs is the same block, and the reviewed entry is the one
 * that can explain itself. Sorted by domain so the page has a stable order and a
 * diff of the published output is readable.
 *
 * `entries` is normally {@link getBlockedDomainPolicy}'s output, already
 * canonicalised. Canonicalising again here is idempotent and keeps the function
 * correct for a caller that passes raw entries.
 */
export function resolveFederationBlocks(
  entries: readonly FederationBlockPolicyEntry[],
  environmentDomains: Iterable<string>,
): readonly PublishedFederationBlock[] {
  const byDomain = new Map<string, PublishedFederationBlock>();

  for (const domain of environmentDomains) {
    const canonical = canonicalBlockedDomain(domain);
    if (canonical.length === 0) continue;
    byDomain.set(canonical, { source: 'operational', domain: canonical, severity: 'suspend' });
  }

  for (const entry of entries) {
    const canonical = canonicalBlockedDomain(entry.domain);
    if (canonical.length === 0) continue;
    byDomain.set(canonical, {
      source: 'policy',
      domain: canonical,
      severity: entry.severity,
      category: entry.category,
      reason: entry.reason,
      since: entry.since,
      corroboratingSources: entry.corroboratingSources,
    });
  }

  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}
