import { describe, expect, it, vi } from 'vitest';

/**
 * THE REAL COMMITTED LIST, THROUGH THE REAL ENGINE.
 *
 * `federationTransparency.test.ts` proves the wiring end to end — policy file to
 * enforced set to HTTP response — but it does so against a `.invalid` FIXTURE,
 * because it was written while the committed policy was empty and a test that
 * looped over an empty list would have proved nothing.
 *
 * That leaves exactly one thing unproven, and it is the thing that would actually
 * hurt: whether the 118 domains WE SHIP are the 118 domains the server refuses.
 * A fixture cannot answer that. Every typo lives in the committed data, not in
 * the merge — a stray space, a `www.` prefix, a domain written with a scheme —
 * and each one produces a published entry that quietly enforces nothing while the
 * transparency page states, in as many words, that it does.
 *
 * So this file mocks NOTHING about the policy. It imports the committed array and
 * the live `isBlockedDomain` — the one built by `@oxyhq/federation`'s
 * `createDomainPolicy` from the same array — and checks them against each other.
 */

// `constants.ts` reaches the Oxy client only to resolve users at request time;
// nothing on the blocked-domain path touches it. Stubbed so this file can import
// the module without standing up the service client.
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(),
  createScopedOxyClient: vi.fn(),
}));

import { FEDERATION_BLOCKS, isBlockedDomain } from '../../../connectors/activitypub/constants';
import { FEDERATION_BLOCK_POLICY } from '../../../connectors/activitypub/federationBlockPolicy';

/**
 * A domain in no input, checked alongside every blocked assertion.
 *
 * RFC 2606 reserves `.invalid`, so this can never become a real instance and
 * start failing for an honest reason.
 */
const UNBLOCKED_CONTROL = 'ordinary-instance.invalid';

describe('the committed policy, as the server actually applies it', () => {
  it('refuses every domain it publishes', () => {
    // Vacuity floor: an empty or truncated policy would satisfy the loop below
    // by never entering it, which is the failure mode this whole file exists for.
    expect(FEDERATION_BLOCK_POLICY.length).toBeGreaterThanOrEqual(118);

    const unenforced = FEDERATION_BLOCK_POLICY.filter(
      (committed) => !isBlockedDomain(committed.domain),
    ).map((committed) => committed.domain);

    // Named rather than counted: a failure here has to say WHICH entry is inert,
    // because that is the entire diagnostic.
    expect(unenforced).toEqual([]);

    // Control. If the engine were rejecting everything — a policy built from a
    // wildcard, a predicate stuck on `true` — the assertion above would pass
    // while meaning nothing.
    expect(isBlockedDomain(UNBLOCKED_CONTROL)).toBe(false);
  });

  it('refuses each one however a remote host happens to write it', () => {
    // A remote actor URI carries whatever case and `www.` the other end chose.
    // The committed file is canonical; the engine has to meet it there.
    for (const committed of FEDERATION_BLOCK_POLICY) {
      expect(isBlockedDomain(committed.domain.toUpperCase())).toBe(true);
      expect(isBlockedDomain(`www.${committed.domain}`)).toBe(true);
    }

    expect(isBlockedDomain(UNBLOCKED_CONTROL.toUpperCase())).toBe(false);
    expect(isBlockedDomain(`www.${UNBLOCKED_CONTROL}`)).toBe(false);
  });

  it('publishes every committed decision with the reason it was taken on', () => {
    const published = new Map(FEDERATION_BLOCKS.map((block) => [block.domain, block]));

    for (const committed of FEDERATION_BLOCK_POLICY) {
      expect(published.get(committed.domain)).toEqual({
        source: 'policy',
        domain: committed.domain,
        severity: committed.severity,
        category: committed.category,
        reason: committed.reason,
        since: committed.since,
        corroboratingSources: committed.corroboratingSources,
      });
    }

    // Nothing is published as a reviewed decision that is not IN the reviewed
    // file — the direction that would let a block appear on the page with a
    // reason nobody wrote.
    expect(FEDERATION_BLOCKS.filter((block) => block.source === 'policy')).toHaveLength(
      FEDERATION_BLOCK_POLICY.length,
    );
  });
});
