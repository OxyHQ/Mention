import { listsService } from '../listsService';
import { authenticatedClient } from '@/utils/api';

jest.mock('@/utils/api', () => ({ authenticatedClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock('@/services/listMutations', () => ({ notifyListChanged: jest.fn() }));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));

const get = authenticatedClient.get as jest.Mock;
const post = authenticatedClient.post as jest.Mock;
const list = (id: string) => ({ id, title: id });

beforeEach(() => jest.resetAllMocks());

it('uses one batch read and keeps the server-provided order', async () => {
  post.mockResolvedValue({ data: { items: [list('b'), list('a')] } });
  await expect(listsService.resolve(['b', 'missing', 'a'])).resolves.toEqual([
    list('b'),
    list('a'),
  ]);
  expect(post).toHaveBeenCalledWith('/lists/resolve', { ids: ['b', 'missing', 'a'] });
  expect(get).not.toHaveBeenCalled();
});

it('does no work for an empty page', async () => {
  await expect(listsService.resolve([])).resolves.toEqual([]);
  expect(post).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it.each([403, 404, 500])(
  'falls back to individual reads on HTTP %s, preserving partial results',
  async (status) => {
    post.mockRejectedValue({ status });
    get.mockImplementation(async (url: string) => {
      if (url.endsWith('/missing')) throw { status: 404 };
      if (url.endsWith('/private')) throw { status: 403 };
      return { data: list(url.slice('/lists/'.length)) };
    });
    await expect(listsService.resolve(['b', 'missing', 'private', 'a'])).resolves.toEqual([
      list('b'),
      list('a'),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(4);
  },
);

it('clears the followed collection on HTTP 401 without individual reads', async () => {
  post.mockRejectedValue({ status: 401 });
  await expect(listsService.resolve(['a', 'b'])).resolves.toEqual([]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
});

it('falls back when an older server returns an unexpected body', async () => {
  post.mockResolvedValue({ data: {} });
  get.mockResolvedValue({ data: list('a') });
  await expect(listsService.resolve(['a'])).resolves.toEqual([list('a')]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(1);
});
