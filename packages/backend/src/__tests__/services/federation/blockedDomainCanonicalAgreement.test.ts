import { describe, expect, it } from 'vitest';
import { createDomainPolicy } from '@oxyhq/federation';
import {
  canonicalBlockedDomain,
  getBlockedDomainPolicy,
} from '../../../connectors/activitypub/federationBlockPolicy';
import { buildBlockedContentDomains } from '../../../scripts/purgeBlockedDomainContent';

/**
 * The purge must target EXACTLY what the engine blocks — never more.
 *
 * These are two different pieces of code answering "is this host blocked": the
 * engine's `createDomainPolicy` decides what to refuse at the wire, and the
 * purge decides what to delete. They agree only if they canonicalise a domain
 * identically, and an earlier version of this script did not — it stripped a
 * trailing dot, which the engine does not. That made the purge strictly BROADER
 * than the enforcement it claims to follow: `example.invalid.` in the blocklist
 * blocks nothing at the wire, but the stripped form matched `example.invalid`
 * and would have deleted that instance's content for a block never in force.
 *
 * For an irreversible action, broader-than-enforcement is the one direction that
 * cannot be allowed, so it is pinned here rather than left to inspection. The
 * engine is driven directly rather than through a mock: a mock would agree with
 * whatever the purge does, which is precisely the failure being guarded.
 */

const OWN = ['mention.earth', 'oxy.so'];

function engineBlocks(blockedDomains: readonly string[], host: string): boolean {
  return createDomainPolicy({
    domain: 'mention.earth',
    actorDomain: 'mention.earth',
    identityApex: 'oxy.so',
    blockedDomains,
  }).isBlockedDomain(host);
}

function purgeTargets(blockedDomains: readonly string[], host: string): boolean {
  return buildBlockedContentDomains(blockedDomains, OWN).has(canonicalBlockedDomain(host));
}

describe('the purge targets exactly what the engine blocks', () => {
  it.each([
    ['spam.example', 'spam.example'],
    ['SPAM.EXAMPLE', 'spam.example'],
    ['www.spam.example', 'spam.example'],
    ['spam.example', 'www.spam.example'],
  ])('agrees on %s vs host %s', (configured, host) => {
    expect(purgeTargets([configured], host)).toBe(engineBlocks([configured], host));
  });

  it('does NOT delete for a trailing-dot entry the engine cannot enforce', () => {
    // The engine keeps the dot, so this entry matches no host at the wire.
    expect(engineBlocks(['spam.example.'], 'spam.example')).toBe(false);
    // The purge must reach the same verdict rather than being helpful.
    expect(purgeTargets(['spam.example.'], 'spam.example')).toBe(false);
  });

  it('never targets a host the engine would let through', () => {
    const configured = ['spam.example'];
    for (const host of [
      'notspam.example',
      'spam.example.evil.test',
      'example',
      'mastodon.social',
      'spam.example.',
    ]) {
      const engine = engineBlocks(configured, host);
      const purge = purgeTargets(configured, host);
      expect(
        purge && !engine,
        `purge would delete ${host} that the engine does not block`,
      ).toBe(false);
    }
  });

  it('uses ONE canonicaliser, shared with the policy module', () => {
    // Re-exported rather than reimplemented, so the two cannot drift again.
    expect(canonicalBlockedDomain('WWW.Spam.EXAMPLE')).toBe('spam.example');
    expect(canonicalBlockedDomain('spam.example.')).toBe('spam.example.');
  });

  it('canonicalises the committed policy through that same function', () => {
    const entries = getBlockedDomainPolicy([{
      domain: 'WWW.Spam.EXAMPLE',
      severity: 'suspend',
      category: 'spam',
      reason: 'test',
      since: '2026-01-01',
      corroboratingSources: [],
    }]);

    expect(entries.map((entry) => entry.domain)).toEqual(['spam.example']);
    expect(purgeTargets(entries.map((entry) => entry.domain), 'spam.example')).toBe(true);
  });
});
