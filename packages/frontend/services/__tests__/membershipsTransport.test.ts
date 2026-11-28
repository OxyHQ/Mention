jest.mock('@/lib/oxyServices', () => {
  const { OxyServices } = jest.requireActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return { oxyServices: new OxyServices({ baseURL: 'https://oxy.fixture.invalid' }) };
});
jest.mock('@/config', () => ({ API_URL: 'https://mention.fixture.invalid' }));
jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { language: 'en' } }));

import { membershipsService } from '../membershipsService';

// Keep Oxy's real HttpService and Mention's utils/api wrapper. Only the HTTP
// transport is synthetic: mocking utils/api concealed a double-unwrapping bug.
afterEach(() => jest.restoreAllMocks());

it('preserves server payloads through the real linked SDK and Mention API wrapper', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  const cases: [string, () => Promise<unknown>, unknown][] = [
    ['mine', () => membershipsService.mine(), { owned: [], joined: [] }],
    [
      'landing',
      () => membershipsService.landing('c'),
      {
        community: { id: 'c' },
        tiers: [],
        membership: null,
        canManage: false,
        viewerBenefits: [],
        paidSubscriptionsAvailable: false,
      },
    ],
    [
      'create',
      () =>
        membershipsService.create({
          ownerOxyUserId: 'owner',
          name: 'Community',
          slug: 'community',
        }),
      { id: 'created' },
    ],
    [
      'update',
      () => membershipsService.update('c', { description: '' }),
      { id: 'updated', description: '' },
    ],
    [
      'content page',
      () => membershipsService.content('c'),
      { items: [{ id: 'post' }], nextCursor: 'next' },
    ],
    [
      'publish',
      () => membershipsService.createContent('c', { kind: 'post', body: 'Private' }),
      { id: 'post', body: 'Private' },
    ],
    ['content', () => membershipsService.readContent('p'), { id: 'p', body: 'Private' }],
    ['insights', () => membershipsService.insights('c'), { membershipsByState: [] }],
    [
      'upload',
      () => membershipsService.upload('c', new Uint8Array([1]).buffer, 'image/png'),
      { id: 'm', mime: 'image/png', size: 1 },
    ],
    [
      'tier',
      () =>
        membershipsService.createTier('c', {
          name: 'Free',
          kind: 'free',
          benefits: ['content_read'],
        }),
      { id: 'tier' },
    ],
    ['teaser', () => membershipsService.teaser('p'), { id: 'p', teaser: 'Public summary' }],
    [
      'reports',
      () => membershipsService.reports('c'),
      [{ id: 'report', reason: 'Private report' }],
    ],
    ['directory', () => membershipsService.directory('c'), [{ oxyUserId: 'member' }]],
    [
      'download',
      () => membershipsService.download('p', 'm'),
      { url: 'https://files.fixture.invalid/signed', expiresIn: 300 },
    ],
  ];
  for (const [name, request, payload] of cases) {
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: payload }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect({ name, payload: await request() }).toEqual({ name, payload });
  }
  expect(fetch).toHaveBeenCalledTimes(cases.length);
  for (const [url] of fetch.mock.calls)
    expect(String(url)).toContain('https://mention.fixture.invalid/membership-communities');
});

it('keeps revocation errors as errors rather than returning absent private data', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'Membership revoked' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await expect(membershipsService.readContent('revoked')).rejects.toMatchObject({ status: 403 });
});

it('sends membership actions through the linked transport without requiring a response payload', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(null, { status: 204 }));
  await membershipsService.join('c', 'tier');
  await membershipsService.leave('c');
  await membershipsService.badge('c', false);
  await membershipsService.vote('post', 'option');
  await membershipsService.report('post', 'reason');
  await membershipsService.resolveReport('c', 'report');
  await membershipsService.revoke('c', 'member');
  await membershipsService.discardUpload('c', 'draft');
  await membershipsService.removeContent('post');
  await membershipsService.updateTier('c', 'tier', { name: 'Updated tier' });
  expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual([
    'PUT',
    'DELETE',
    'PATCH',
    'PUT',
    'POST',
    'POST',
    'DELETE',
    'DELETE',
    'DELETE',
    'PATCH',
  ]);
  expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ tierId: 'tier' }));
  expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ publicBadge: false }));
});
