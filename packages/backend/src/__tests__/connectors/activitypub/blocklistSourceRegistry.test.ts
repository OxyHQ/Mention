import { describe, expect, it } from 'vitest';
import {
  BLOCKLIST_SOURCE_INSTANCES,
  BLOCKLIST_SOURCE_REGISTRY,
  operatorOf,
  sourceRank,
  tallyOperators,
} from '../../../connectors/activitypub/blocklistSourceRegistry';

/**
 * The registry is the only thing that makes a corroboration count mean anything.
 *
 * Its failure mode is silent: two sites of one moderation team clearing a
 * threshold of two, which reads on every report and every policy entry as
 * "independently corroborated". The first production run got exactly that wrong
 * — 116 of 196 candidates rested on `mastodon.social` + `mastodon.online` alone.
 * So the pairs are asserted by name, and so is the trap in the other direction:
 * two hostnames that look related and are not.
 */
describe('blocklist source registry', () => {
  it('declares an operator and its evidence for every polled instance', () => {
    // Vacuity floor: an empty or truncated registry would pass every assertion
    // below about what it does NOT contain.
    expect(BLOCKLIST_SOURCE_REGISTRY.length).toBe(13);
    expect(BLOCKLIST_SOURCE_INSTANCES).toEqual(
      BLOCKLIST_SOURCE_REGISTRY.map((source) => source.instance),
    );

    for (const source of BLOCKLIST_SOURCE_REGISTRY) {
      expect(source.instance).toBe(source.instance.toLowerCase());
      expect(source.operator.length).toBeGreaterThan(0);
      // The evidence is the whole basis of the operator claim. A row without it
      // is an assertion nobody can re-check, which is the thing being avoided.
      expect(source.evidence).toMatch(/contact /);
      expect(source.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    expect(new Set(BLOCKLIST_SOURCE_INSTANCES).size).toBe(BLOCKLIST_SOURCE_INSTANCES.length);
  });

  it('collapses the two instance pairs that share a moderation team', () => {
    // Published contact account: @Mastodon@mastodon.social, from BOTH.
    expect(operatorOf('mastodon.online')).toBe(operatorOf('mastodon.social'));
    // Published contact mailbox: support@mastodonapp.uk, from BOTH.
    expect(operatorOf('universeodon.com')).toBe(operatorOf('mastodonapp.uk'));

    expect(new Set(BLOCKLIST_SOURCE_REGISTRY.map((source) => source.operator)).size).toBe(11);
  });

  it('ranks an operator’s principal site first, so a pair names it consistently', () => {
    // When both of an operator's instances publish the same block, the earlier
    // one here is the name that reaches a policy entry's `corroboratingSources`.
    expect(sourceRank('mastodon.social')).toBeLessThan(sourceRank('mastodon.online'));
    expect(sourceRank('universeodon.com')).toBeLessThan(sourceRank('mastodonapp.uk'));
    // An unregistered instance ranks last, and is always alone in its operator.
    expect(sourceRank('unknown.example')).toBeGreaterThan(sourceRank('mastodonapp.uk'));
  });

  it('does not invent a pair out of two similar hostnames', () => {
    // mstdn.social is stux; mstdn.jp is Sujitech. Anything keyed on the name
    // would merge them and quietly lose a real, independent corroboration.
    expect(operatorOf('mstdn.social')).not.toBe(operatorOf('mstdn.jp'));
  });

  it('counts one operator for two of its instances', () => {
    expect(tallyOperators(['mastodon.social', 'mastodon.online']).operators).toHaveLength(1);
    expect(tallyOperators(['mastodon.social', 'mstdn.social']).operators).toHaveLength(2);
  });

  it('counts an unregistered instance as its own operator, and says so', () => {
    // The permissive direction, so a manual run naming its own sources still
    // produces a count — but never silently, because the count then rests on an
    // assumption nobody made.
    const tally = tallyOperators(['mastodon.social', 'unknown.example']);

    expect(tally.operators).toEqual(['mastodon-gmbh', 'unknown.example']);
    expect(tally.unregistered).toEqual(['unknown.example']);
    expect(operatorOf('unknown.example')).toBeNull();
  });
});
