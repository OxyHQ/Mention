/** Real cold discovery. No API stubs; requires zero-state artifacts from both databases. */
import { expect, test } from '../fixtures';
import { loadColdEvidence } from '../coldIdentityEvidence';
import { API_ORIGIN } from '../environment';

test.skip(process.env.MENTION_E2E_COLD_IDENTITY !== '1', 'Requires reviewed absence artifacts and explicit live opt-in');

interface ActorReply { actor: { oxyUserId: string; handle: string; externalId: string } | null }
interface ProfileReply { data: { id: string; username: string; bio?: string } }

test('cold public discovery preserves one Oxy identity and source profile', async ({ page, context, candidate }, testInfo) => {
  const evidence = loadColdEvidence();
  await testInfo.attach('validated-absence-manifest', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  const appearances: Array<{ phase: string; observedAt: string; oxyUserId: string; handle: string; bio?: string }> = [];
  const firstRequestAt = new Date().toISOString();
  let canonicalId: string | undefined;
  let canonicalHandle: string | undefined;

  // Each search starts from a new document, with no retained React Query state.
  for (const [index, source] of evidence.sources.entries()) {
    const reply = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === API_ORIGIN && url.pathname === '/federation/resolve'
        && url.searchParams.get('handle') === source.transportAcct;
    });
    await page.goto(`/search?q=${encodeURIComponent(source.transportAcct)}`);
    const response = await reply;
    expect(response.status()).toBe(200);
    const body: ActorReply = await response.json();
    expect(body.actor?.oxyUserId).toBeTruthy();
    expect(evidence.sources.map(item => item.canonicalAcct)).toContain(body.actor?.handle);
    const actor = body.actor;
    if (!actor?.oxyUserId || !actor.handle) throw new Error('Discovery did not return an Oxy identity');
    expect(actor.externalId).toBe(source.actorUri);
    canonicalId ??= actor.oxyUserId;
    canonicalHandle ??= actor.handle;
    expect(actor.oxyUserId).toBe(canonicalId);
    expect(actor.handle).toBe(canonicalHandle);
    await expect(page.getByText(`@${actor.handle}`, { exact: true }).first()).toBeVisible();
    if (source.transportAcct !== actor.handle) await expect(page.getByText(`@${source.transportAcct}`, { exact: true })).toHaveCount(0);
    appearances.push({ phase: `search-${index + 1}`, observedAt: new Date().toISOString(), ...actor });

    const profileResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === 'https://api.oxy.so' && url.pathname === '/profiles/resolve'
        && url.searchParams.get('handle') === actor.handle;
    });
    await page.getByText(`@${actor.handle}`, { exact: true }).first().click();
    const profileHttp = await profileResponse;
    expect(profileHttp.status()).toBe(200);
    const { data: profile }: ProfileReply = await profileHttp.json();
    expect(profile.id).toBe(canonicalId);
    expect(profile.username).toBe(canonicalHandle);
    expect(profile.bio).toContain(evidence.expectedBioText);
    expect(profile.bio).toContain(`@${evidence.expectedMentionHandle}`);
    for (const boilerplate of evidence.forbiddenBioText) expect(profile.bio?.toLowerCase()).not.toContain(boilerplate.toLowerCase());
    if (!canonicalHandle) throw new Error('Discovery did not establish a canonical handle');
    await expect(page).toHaveTitle(new RegExp(`@${canonicalHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(page.getByText(evidence.expectedBioText, { exact: false }).first()).toBeVisible();
    for (const boilerplate of evidence.forbiddenBioText) await expect(page.getByText(boilerplate, { exact: false })).toHaveCount(0);
    await expect(page.getByText(evidence.expectedMentionLabel, { exact: true }).first()).toBeVisible();
    appearances.push({ phase: `profile-${index + 1}`, observedAt: new Date().toISOString(), oxyUserId: profile.id, handle: profile.username, bio: profile.bio });
    await page.screenshot({ path: testInfo.outputPath(`first-profile-${index + 1}.png`), fullPage: true });
  }

  if (!canonicalHandle) throw new Error('Discovery did not establish a canonical handle');
  // Text mentions are RN Text onPress targets, not HTML anchors.
  await page.getByText(evidence.expectedMentionLabel, { exact: true }).first().click();
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname)).toBe(`/@${evidence.expectedMentionHandle}`);
  for (const source of evidence.sources.filter(item => item.transportAcct !== item.canonicalAcct)) {
    await page.goto(`/@${source.transportAcct}`);
    await expect(page.getByText('Profile not found', { exact: false })).toBeAttached();
    await expect(page.getByText(`@${source.transportAcct}`, { exact: true })).toHaveCount(0);
    await expect(page).not.toHaveTitle(new RegExp(`@${canonicalHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }

  // Drop browser storage, then repeat actual discovery; identity must not mint again.
  await context.clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  const source = evidence.sources[0];
  const repeat = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === API_ORIGIN && url.pathname === '/federation/resolve'
      && url.searchParams.get('handle') === source.transportAcct;
  });
  await page.goto(`/search?q=${encodeURIComponent(source.transportAcct)}`);
  const repeatHttp = await repeat;
  expect(repeatHttp.status()).toBe(200);
  const repeated: ActorReply = await repeatHttp.json();
  expect(repeated.actor?.oxyUserId).toBe(canonicalId);
  expect(repeated.actor?.handle).toBe(canonicalHandle);
  expect(repeated.actor?.externalId).toBe(source.actorUri);
  expect(candidate.scriptErrors).toEqual([]);
  await testInfo.attach('public-discovery-evidence', {
    body: JSON.stringify({ firstRequestAt, appearances, repeated: repeated.actor, completedAt: new Date().toISOString() }, null, 2),
    contentType: 'application/json',
  });
});
