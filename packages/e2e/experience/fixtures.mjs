import { readFileSync } from 'node:fs';
export const MENTION_ORIGIN = process.env.MENTION_EXPERIENCE_ORIGIN ?? 'http://localhost:8107';
export const CLARITY_ORIGIN = process.env.CLARITY_EXPERIENCE_ORIGIN ?? 'http://localhost:8108';
const owner = {
  id: 'experience-owner',
  username: 'experience-owner',
  kind: 'personal',
  name: { first: 'Alex', last: 'Rivera', displayName: 'Alex Rivera' },
  email: 'alex@example.test',
  bio: 'Product designer',
  avatar: null,
  coverPhoto: null,
  verified: false,
  createdAt: '2020-01-01T00:00:00.000Z',
  privacy: { isPrivate: false },
  counts: { followers: 0, following: 0, posts: 0 },
  locale: 'en',
};
const org = (id, name) => ({
  accountId: id,
  name,
  username: id,
  organizationType: 'business',
  avatar: null,
  legalName: null,
  websiteUrl: `https://${id}.example`,
  countryCode: 'US',
  aliases: [],
  verifiedDomains: [],
  claimStatus: 'unclaimed',
  status: 'active',
  mergedIntoAccountId: null,
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
});
const companies = [
  org('apple', 'Apple'),
  org('airbnb', 'Airbnb'),
  {
    ...org('69b2d3df5d12f58c9800d651', 'Oxy'),
    username: 'oxy',
    avatar: '69b85ff8a08af16d4b87155e',
    websiteUrl: 'https://oxy.so',
  },
];
const entry = (id, title, company, startDate, endDate) => ({
  id,
  oxyUserId: owner.id,
  title,
  employerOxyAccountId: company,
  startDate,
  endDate,
  employmentType: 'full-time',
  location: 'Cupertino, California, United States',
  description: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});
const entries = [
  entry('current', 'Designer', 'apple', '2022-10', null),
  entry('airbnb-role', 'VP of Design', 'airbnb', '2021-06', '2022-10'),
  entry('designer', 'Designer', 'apple', '2013-10', '2021-06'),
  entry('director', 'Creative Director. Video', 'apple', '2005-10', '2013-10'),
];
async function setup(context, authenticated = true, viewer = owner) {
  const viewerToken = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: viewer.id,
        userId: viewer.id,
        sessionId: 'experience-session',
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
  if (authenticated)
    await context.addInitScript(
      ({ owner, token }) => {
        localStorage.setItem(
          'oxy.auth.v1',
          JSON.stringify({
            sessionId: 'experience-session',
            userId: owner.id,
            deviceId: 'experience-device',
            deviceSecret: 'fixture-only',
          }),
        );
        localStorage.setItem(
          'oxy.auth.token.v1',
          JSON.stringify({
            accessToken: token,
            expiresAt: new Date(Date.now() + 7200000).toISOString(),
          }),
        );
      },
      { owner: viewer, token: viewerToken },
    );
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (
      [MENTION_ORIGIN, CLARITY_ORIGIN].includes(url.origin) ||
      !['http:', 'https:'].includes(url.protocol)
    )
      return route.continue();
    if (url.hostname === 'cloud.oxy.so' && url.pathname.includes('69b85ff8a08af16d4b87155e'))
      return route.fulfill({
        contentType: 'image/webp',
        body: readFileSync(new URL('./fixtures/oxy-logo.webp', import.meta.url)),
      });
    const path = url.pathname,
      method = req.method();
    const json = (data, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
        headers: {
          'access-control-allow-origin': req.headers()['origin'] || MENTION_ORIGIN,
          'access-control-allow-credentials': 'true',
        },
      });
    if (method === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': req.headers()['origin'] || MENTION_ORIGIN,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
    if (path === '/safety/supervision') return json({ self: null, children: [], invitations: [] });
    if (path.startsWith('/auth/oauth/client/'))
      return json({
        application: {
          id: 'fixture-app',
          name: 'Fixture',
          type: 'internal',
          isOfficial: true,
          isInternal: true,
          clientId: path.split('/').pop(),
          scopes: [],
        },
      });
    if (path.startsWith('/api/experience')) {
      if (method === 'GET') return json({ items: entries, nextCursor: null });
      if (method === 'POST') {
        const e = entry(`new-${entries.length}`, '', '', '2020-01', null);
        Object.assign(e, req.postDataJSON());
        entries.unshift(e);
        return json(e, 201);
      }
      const index = entries.findIndex((e) => e.id === path.split('/').pop());
      if (index < 0)
        return json({ error: { code: 'not_found', message: 'Experience not found' } }, 404);
      if (method === 'PUT') {
        Object.assign(entries[index], req.postDataJSON());
        return json(entries[index]);
      }
      if (method === 'DELETE') {
        entries.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
    }
    if (path === '/organizations/batch')
      return json({
        items: req
          .postDataJSON()
          .ids.map((id) => ({
            requestedAccountId: id,
            organization: companies.find((c) => c.accountId === id),
          }))
          .filter((x) => x.organization),
        missingIds: [],
      });
    if (path === '/organizations' && method === 'POST') {
      const c = { ...org('new-company', req.postDataJSON().name), ...req.postDataJSON() };
      companies.push(c);
      return json(c, 201);
    }
    if (path === '/organizations' || path === '/organizations/search')
      return json({
        items: companies.filter((c) =>
          c.name.toLowerCase().includes((url.searchParams.get('query') || '').toLowerCase()),
        ),
        nextCursor: null,
      });
    if (path.includes('/organizations/'))
      return json(companies.find((c) => c.accountId === path.split('/').pop()) || companies[0]);
    if (path === '/session/device/token')
      return json({
        accessToken: viewerToken,
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
        userId: viewer.id,
        sessionId: 'experience-session',
        nextDeviceSecret: 'fixture-only',
        user: viewer,
      });
    if (path.startsWith('/session/user/') || path === '/users/me') return json(viewer);
    if (path === `/users/${owner.id}` || path.startsWith('/profiles/username/')) return json(owner);
    if (path === `/users/${viewer.id}`) return json(viewer);
    if (path.includes('follow') && path.includes('status'))
      return json({ isFollowing: false, isFollowedBy: false, isBlocked: false });
    if (path.startsWith('/suggestions/')) return json({ suggestions: [] });
    if (path.includes('settings') || path.includes('preferences')) return json({});
    if (path.includes('/appearance')) return json({});
    if (path.includes('/notifications/unread')) return json({ count: 0 });
    if (path.includes('entitlements')) return json({});
    if (path.includes('/users/by-ids')) return json({ users: [owner] });
    if (path.includes('/session/sessions') || path.startsWith('/session/device/sessions/'))
      return json([]);
    if (path.includes('/accounts')) return json({ accounts: [], items: [] });
    if (path.includes('/feed') || path.includes('/posts'))
      return json({ posts: [], items: [], hasMore: false, nextCursor: null });
    if (path.includes('/lanes')) return json({ items: [], lanes: [], nextCursor: null });
    if (
      ['https://api.mention.earth', 'https://api.oxy.so'].includes(url.origin) &&
      (path === '/socket.io' || path === '/socket.io/')
    )
      return route.abort();
    return json({ items: [], data: [], nextCursor: null });
  });
}
export { setup, entries, companies, owner };
