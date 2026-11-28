const mockFetch = jest.fn();
const mockAuthenticatedResponse = jest.fn();
const mockGetAccessToken = jest.fn();
const mockCreateLinkedClient = jest.fn().mockReturnValue({
  fetch: (...args: unknown[]) => mockAuthenticatedResponse(...args),
  dispose: jest.fn(),
});

jest.mock('@/config', () => ({ CLARITY_API_URL: 'https://clarity.example' }));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    http: { getAccessToken: () => mockGetAccessToken() },
    createLinkedClient: (...args: unknown[]) => mockCreateLinkedClient(...args),
  },
}));

// The real packaged Clarity SDK owns path encoding, serialization and errors.
// Install fetch before importing: each client captures its transport at creation.
global.fetch = mockFetch;
const { experienceService } =
  require('../experienceService') as typeof import('../experienceService');

const input = {
  title: 'Designer',
  employerOxyAccountId: 'org-oxy',
  startDate: '2024-01',
  endDate: null,
};
const experience = {
  ...input,
  id: 'exp-1',
  oxyUserId: 'user-1',
  employmentType: null,
  location: null,
  description: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};
const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccessToken.mockReturnValue('current-token');
  mockAuthenticatedResponse.mockResolvedValue(response(experience));
});

test('reads public history without touching the Oxy session and encodes opaque account ids', async () => {
  mockFetch.mockResolvedValue(response({ items: [experience], nextCursor: null }));
  mockGetAccessToken.mockReturnValue(null);

  await expect(experienceService.list('user/a?x=1')).resolves.toEqual([experience]);

  expect(mockFetch).toHaveBeenCalledWith(
    'https://clarity.example/api/experience/users/user%2Fa%3Fx%3D1',
    expect.objectContaining({ method: 'GET' }),
  );
  expect(new Headers(mockFetch.mock.calls[0][1].headers).has('authorization')).toBe(false);
  expect(mockGetAccessToken).not.toHaveBeenCalled();
  expect(mockAuthenticatedResponse).not.toHaveBeenCalled();
});

test('delegates owner writes to Oxy canonical authenticated response transport', async () => {
  await expect(experienceService.create(input)).resolves.toEqual(experience);
  await expect(experienceService.update('exp/a?x=1', input)).resolves.toEqual(experience);
  mockAuthenticatedResponse.mockResolvedValue(response(undefined, 204));
  await expect(experienceService.remove('exp/a?x=1')).resolves.toBeUndefined();

  const calls = mockAuthenticatedResponse.mock.calls.map(([url, init]) => ({ url, ...init }));
  expect(calls.map(({ url, method }) => [url, method])).toEqual([
    ['https://clarity.example/api/experience', 'POST'],
    ['https://clarity.example/api/experience/exp%2Fa%3Fx%3D1', 'PUT'],
    ['https://clarity.example/api/experience/exp%2Fa%3Fx%3D1', 'DELETE'],
  ]);
  expect(JSON.parse(calls[0].body)).toEqual(input);
  expect(JSON.parse(calls[1].body)).toEqual(input);
  expect(new Headers(calls[0].headers).has('authorization')).toBe(false);
  expect(mockGetAccessToken).not.toHaveBeenCalled();
  expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('leaves missing-session and account-switch refusals to the shared linked transport', async () => {
  const error = new Error('Session changed during refresh');
  mockAuthenticatedResponse.mockRejectedValueOnce(error);
  await expect(experienceService.create(input)).rejects.toBe(error);
  expect(mockAuthenticatedResponse).toHaveBeenCalledTimes(1);
  expect(mockGetAccessToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

test('preserves Clarity ownership and validation errors for the editor', async () => {
  mockAuthenticatedResponse.mockResolvedValue(
    response(
      { error: { code: 'forbidden', message: 'Not your experience', requestId: 'req-1' } },
      403,
    ),
  );
  await expect(experienceService.update('other-owned', input)).rejects.toMatchObject({
    status: 403,
    code: 'forbidden',
    message: 'Not your experience',
  });
  expect(mockAuthenticatedResponse).toHaveBeenCalledTimes(1);
});

test('preserves Oxy refresh and session failures without retrying a mutation', async () => {
  const error = new Error('Session changed during refresh');
  mockAuthenticatedResponse.mockRejectedValue(error);
  await expect(experienceService.create(input)).rejects.toBe(error);
  expect(mockAuthenticatedResponse).toHaveBeenCalledTimes(1);
});

test('surfaces public failures instead of returning an empty history', async () => {
  mockFetch.mockResolvedValue(
    response({ error: { code: 'not_found', message: 'Profile unavailable' } }, 404),
  );
  await expect(experienceService.list('missing')).rejects.toMatchObject({ status: 404 });
});

test('uses the current viewer session for private history without sharing the anonymous transport', async () => {
  mockAuthenticatedResponse.mockResolvedValue(response({ items: [experience], nextCursor: null }));
  await expect(experienceService.list('user-1', true)).resolves.toEqual([experience]);
  expect(mockAuthenticatedResponse).toHaveBeenCalledWith(
    'https://clarity.example/api/experience/users/user-1',
    expect.objectContaining({ method: 'GET' }),
  );
  expect(mockFetch).not.toHaveBeenCalled();
});
