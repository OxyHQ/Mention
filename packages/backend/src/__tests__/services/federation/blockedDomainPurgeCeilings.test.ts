import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_PURGE_CEILINGS,
  describeBreaches,
  evaluatePurgeCeilings,
  type PurgeMeasurement,
} from '../../../services/federation/blockedDomainPurgeCeilings';

/**
 * The circuit breaker that decides whether an automatic, irreversible deletion
 * may proceed without a human.
 *
 * The case that matters is a typo in the policy file naming a large legitimate
 * instance. These tests are written from that scenario rather than from the
 * implementation: the numbers below are the production measurement the ceilings
 * were derived from (196 domains, 6,401 posts, 1,135 actors, zero local
 * follows), so a change that would have let the typo through fails here.
 */

const CORPUS = { federatedPosts: 120_000, federatedActors: 40_000 };

function measurement(
  perDomain: Record<string, Partial<{
    posts: number; actors: number; localFollows: number; localContent: number;
  }>>,
  corpus = CORPUS,
): PurgeMeasurement {
  const entries = new Map<string, {
    posts: number; actors: number; localFollows: number; localContent: number;
  }>();
  let posts = 0;
  let actors = 0;
  for (const [domain, counts] of Object.entries(perDomain)) {
    const filled = {
      posts: counts.posts ?? 0,
      actors: counts.actors ?? 0,
      localFollows: counts.localFollows ?? 0,
      localContent: counts.localContent ?? 0,
    };
    entries.set(domain, filled);
    posts += filled.posts;
    actors += filled.actors;
  }
  return { corpus, total: { posts, actors }, perDomain: entries };
}

describe('the automatic purge circuit breaker', () => {
  it('lets an ordinary blocklist domain through', () => {
    // The real shape: a spam host with a few hundred posts, a handful of actors,
    // nobody here following it and nobody replying to it.
    const breaches = evaluatePurgeCeilings(measurement({
      'spam.example': { posts: 340, actors: 12 },
    }));

    expect(breaches).toEqual([]);
  });

  it('lets the whole measured production blocklist through on its per-domain shape', () => {
    // 196 domains averaging ~33 posts each, largest ~1,440. Nothing here should
    // need a human, or the automation is useless.
    const domains: Record<string, { posts: number; actors: number }> = {
      'largest.example': { posts: 1_440, actors: 90 },
    };
    for (let i = 0; i < 195; i++) {
      domains[`d${i}.example`] = { posts: 25, actors: 5 };
    }

    const breaches = evaluatePurgeCeilings(measurement(domains));

    // Only the batch-wide ceiling may speak here, and 6.3k of 120k is under it.
    expect(breaches).toEqual([]);
  });

  it('REFUSES a domain a local user follows, however small it is', () => {
    // The sharpest discriminator: zero across all 196 real blocklist domains, so
    // any non-zero value is the shape of a mistake.
    const breaches = evaluatePurgeCeilings(measurement({
      'typo.example': { posts: 3, actors: 1, localFollows: 1 },
    }));

    expect(breaches).toHaveLength(1);
    expect(breaches[0].ceiling).toBe('localFollowsPerDomain');
    expect(breaches[0].domain).toBe('typo.example');
  });

  it('REFUSES a mistyped large instance', () => {
    // The scenario the breaker exists for: a lookalike of a major instance,
    // pasted into the policy file, deploying unattended.
    const breaches = evaluatePurgeCeilings(measurement({
      'mastodon.social': { posts: 46_000, actors: 9_000, localFollows: 210, localContent: 1_800 },
    }));

    const tripped = breaches.map((breach) => breach.ceiling).sort();
    expect(tripped).toContain('localFollowsPerDomain');
    expect(tripped).toContain('postsPerDomain');
    expect(tripped).toContain('actorsPerDomain');
    expect(tripped).toContain('postsTotal');
    // Every breach, not just the first: a held batch is reviewed once, so the
    // reviewer gets the whole picture.
    expect(breaches.length).toBeGreaterThan(3);
  });

  it('REFUSES a batch of individually-ordinary domains that together take a fifth of the corpus', () => {
    const corpus = { federatedPosts: 100_000, federatedActors: 40_000 };
    const batchOf = (count: number, posts: number): Record<string, { posts: number }> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`d${i}.example`, { posts }]),
      );

    // 20 × 700 = 14,000, i.e. 14% of the corpus. Every domain is individually
    // far under its own ceiling AND the batch is under the batch ceiling.
    expect(evaluatePurgeCeilings(measurement(batchOf(20, 700), corpus))).toEqual([]);

    // 60 × 400 = 24,000, i.e. 24%. Each domain is even smaller than before, so
    // ONLY the batch ceiling can speak — which is the whole point of having one.
    const trips = evaluatePurgeCeilings(measurement(batchOf(60, 400), corpus));
    expect(trips.map((breach) => breach.ceiling)).toEqual(['postsTotal']);
  });

  it('REFUSES rather than dividing by zero when the corpus is empty', () => {
    // A positive count against an empty corpus is not "a small fraction" — and an
    // empty corpus is itself a sign the measurement is wrong.
    const breaches = evaluatePurgeCeilings(measurement(
      { 'spam.example': { posts: 5_000, actors: 900 } },
      { federatedPosts: 0, federatedActors: 0 },
    ));

    expect(breaches.map((breach) => breach.ceiling)).toContain('postsPerDomain');
  });

  it('scales with the corpus instead of staying pinned to today\'s numbers', () => {
    // The same absolute count is fine in a large corpus and a breach in a small
    // one. An absolute-only ceiling could not tell these apart.
    const small = evaluatePurgeCeilings(measurement(
      { 'spam.example': { posts: 3_000 } },
      { federatedPosts: 10_000, federatedActors: 4_000 },
    ));
    const large = evaluatePurgeCeilings(measurement(
      { 'spam.example': { posts: 3_000 } },
      { federatedPosts: 500_000, federatedActors: 40_000 },
    ));

    expect(small.map((breach) => breach.ceiling)).toContain('postsPerDomain');
    expect(large).toEqual([]);
  });

  it('never trips on a handful of documents, whatever the corpus', () => {
    const breaches = evaluatePurgeCeilings(measurement(
      { 'spam.example': { posts: 4, actors: 1, localContent: 2 } },
      { federatedPosts: 12, federatedActors: 3 },
    ));

    expect(breaches).toEqual([]);
  });

  it('gives every ceiling a stated reason', () => {
    // A threshold with no argument next to it is a guess, and the next person
    // cannot tell a tuned number from an invented one.
    for (const [name, ceiling] of Object.entries(AUTOMATIC_PURGE_CEILINGS)) {
      expect(ceiling.reason.length, `${name} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('describes a breach with the number AND the limit it was measured against', () => {
    const breaches = evaluatePurgeCeilings(measurement({
      'typo.example': { posts: 3, localFollows: 4 },
    }));

    expect(describeBreaches(breaches)).toContain('localFollowsPerDomain(typo.example)=4');
  });
});
