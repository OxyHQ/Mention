/**
 * Browser routing contract with an Oxy profile fixture and an empty browser cache.
 * This does not prove Oxy's upstream cold discovery; its real-PG API suite owns that.
 */
import { expect, test } from '../fixtures';

const username = 'freshalias990@instagram.com';
const alias = 'freshalias990@threads.net';
const transport = 'freshalias990@bridge.example';
const externalIdentities = [
  { canonicalAcct: username, network: 'instagram.com', protocol: 'activitypub', actorUri: 'https://bridge.example/users/freshalias990', transportAcct: transport, sourceUserId: 'ig-source-990' },
  { canonicalAcct: alias, network: 'threads.net', protocol: 'activitypub', actorUri: 'https://threads.net/ap/users/freshalias990', transportAcct: alias, sourceUserId: 'threads-source-990' },
];

for (const scenario of [
  { handle: alias, proven: true, visible: true },
  { handle: transport, proven: true, visible: false },
  { handle: alias, proven: false, visible: false },
]) {
  test(`Oxy routing fixture: ${scenario.handle}, proof=${scenario.proven}`, async ({ page, candidate }) => {
    let resolved = false;
    await page.route('https://api.oxy.so/profiles/resolve?**', async (route) => {
      expect(new URL(route.request().url()).searchParams.get('handle')).toBe(scenario.handle);
      resolved = true;
      await route.fulfill({ json: { success: true, data: {
        id: 'fresh-person-990', username, type: 'federated', isFederated: true, name: { displayName: 'Fresh Alias 990' }, bio: 'Public identity routing fixture',
        externalIdentities: scenario.proven ? externalIdentities : [], redirectedUserIds: [],
      } } });
    });
    await page.goto(`/@${scenario.handle}`);
    await expect.poll(() => resolved).toBe(true);
    if (scenario.visible) {
      await expect(page).toHaveTitle(/Fresh Alias 990/);
      await expect(page).toHaveTitle(/@freshalias990@instagram.com/);
    } else {
      // Wait for the resolved refusal state (web keeps profile chrome in a portal).
      await expect(page.getByText('Profile not found', { exact: false })).toBeAttached();
      await expect(page).not.toHaveTitle(/Fresh Alias 990/);
    }
    expect(candidate.scriptErrors).toEqual([]);
  });
}

