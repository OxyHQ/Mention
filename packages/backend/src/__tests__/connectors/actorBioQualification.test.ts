/**
 * The wiring, not the mechanism.
 *
 * `qualifyBareHandles` is tested in shared-types and the engine hook is tested in
 * `@oxyhq/federation`; both were green while Mention's bios stayed unqualified,
 * because nothing connected them. A hook that is never supplied is invisible —
 * the resolver falls back to the previous behaviour silently, by design — so the
 * only thing that can catch a missing wire is a test that looks at the adapter.
 */

import { activityPubActorResolverConfig } from '../../connectors/activitypub/actor.service';

describe('Mention supplies the bio handle-qualification rule', () => {
  it('wires qualifyHandles into the actor text adapter', () => {
    expect(typeof activityPubActorResolverConfig.text.qualifyHandles).toBe('function');
  });

  it('qualifies against the network domain it is handed', () => {
    const qualify = activityPubActorResolverConfig.text.qualifyHandles;
    if (!qualify) throw new Error('qualifyHandles is not wired');

    expect(qualify('Now building @thinkymachines. Previously CTO @openai', 'x.com'))
      .toBe('Now building @thinkymachines@x.com. Previously CTO @openai@x.com');
  });

  it('uses the shared scanner rather than a bio-only rule', () => {
    const qualify = activityPubActorResolverConfig.text.qualifyHandles;
    if (!qualify) throw new Error('qualifyHandles is not wired');

    // These three exclusions come from the ONE entity scanner. Asserting them
    // here is what would catch a future "simpler" bio-only regex replacing it:
    // each is a case a naive `@\w+` rewrite gets wrong.
    expect(qualify('see https://x.com/@handle', 'x.com')).toBe('see https://x.com/@handle');
    expect(qualify('mail nate@oxy.so', 'x.com')).toBe('mail nate@oxy.so');
    expect(qualify('ping @alice@mastodon.social', 'x.com')).toBe('ping @alice@mastodon.social');
  });
});
