import { describe, expect, it, vi } from 'vitest';

/**
 * The seam that decides which domains the AUTOMATIC purge may delete for.
 *
 * One property is load-bearing and worth its own file: the environment lever
 * must not be able to reach it. `FEDERATION_BLOCKED_DOMAINS` is an additive
 * emergency stop that anyone with console access can set with no diff, no author
 * and no review — fine for refusing new content instantly, unacceptable as the
 * trigger for irreversible deletion. The boundary is structural (the accessor
 * this delegates to takes reviewed entries only), and this asserts it stays that
 * way rather than trusting that nobody re-points it at the merged view.
 */

const REVIEWED = 'reviewed.example';
const EMERGENCY = 'emergency.example';

describe('loadBlockedDomainPolicy', () => {
  it('returns the reviewed committed policy', async () => {
    vi.resetModules();
    vi.doMock('../../../connectors/activitypub/federationBlockPolicy', () => ({
      getBlockedDomainPolicy: () => [{
        domain: REVIEWED,
        severity: 'suspend',
        category: 'spam',
        reason: 'reviewed and committed',
        since: '2026-01-01',
        corroboratingSources: [],
      }],
    }));

    const { loadBlockedDomainPolicy } = await import(
      '../../../services/federation/blockedDomainPolicySource'
    );

    expect(loadBlockedDomainPolicy().map((entry) => entry.domain)).toEqual([REVIEWED]);
    vi.doUnmock('../../../connectors/activitypub/federationBlockPolicy');
  });

  it('reads the REVIEWED accessor, never the merged view that includes the env lever', async () => {
    vi.resetModules();
    const reviewed = vi.fn(() => [{
      domain: REVIEWED,
      severity: 'suspend' as const,
      category: 'spam' as const,
      reason: 'reviewed and committed',
      since: '2026-01-01',
      corroboratingSources: [] as readonly string[],
    }]);
    const merged = vi.fn(() => [{ domain: EMERGENCY, source: 'operational' }]);
    vi.doMock('../../../connectors/activitypub/federationBlockPolicy', () => ({
      getBlockedDomainPolicy: reviewed,
      resolveFederationBlocks: merged,
    }));

    const { loadBlockedDomainPolicy } = await import(
      '../../../services/federation/blockedDomainPolicySource'
    );
    const domains = loadBlockedDomainPolicy().map((entry) => entry.domain);

    expect(domains).toEqual([REVIEWED]);
    // An emergency env block stops new content instantly; it must not also
    // delete history until someone writes the entry up and commits it.
    expect(domains).not.toContain(EMERGENCY);
    expect(merged).not.toHaveBeenCalled();
    vi.doUnmock('../../../connectors/activitypub/federationBlockPolicy');
  });
});
