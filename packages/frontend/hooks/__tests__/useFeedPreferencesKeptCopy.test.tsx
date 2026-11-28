import {
  createAccounts,
  DataProvider,
  setActiveStore,
  type Store,
  withStore,
} from '@oxy.so/bloom-data';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import type { FeedPreferences } from '@mention/shared-types/mtn/presetFeeds';
import { useFeedPreferences, type UseFeedPreferences } from '@/hooks/useFeedPreferences';
import { SavedFeeds } from '@/lib/savedFeedsCopy';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The home tab row is kept on this device per account, so a returning viewer's
 * first paint has their tabs. One account's copy must never reach another.
 */

let mockViewerId = 'viewer-a';
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockViewerId }, canUsePrivateApi: true }),
}));
jest.mock('@/hooks/useAgeProtections', () => ({
  useAgeProtections: () => ({ feedProfile: 'adult' }),
}));
const mockGet = jest.fn();
jest.mock('@/services/feedPreferencesService', () => ({
  feedPreferencesService: { get: () => mockGet(), update: jest.fn() },
}));

const layout = (key: string): FeedPreferences => ({
  savedFeeds: [{ key, descriptor: `custom|${key}`, pinned: true, order: 0 }],
});

let accounts: ReturnType<typeof createAccounts>;
let seen: UseFeedPreferences | undefined;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient;

function Probe() {
  seen = useFeedPreferences();
  return null;
}

async function render(store: Store) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <DataProvider store={store}>
          <Probe />
        </DataProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** React Query tells its observers on the next macrotask. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const pinned = () => seen?.pinnedFeeds.map((feed) => feed.key);

function keep(store: Store, viewerId: string, key: string, readAt = Date.now()) {
  withStore(store, () => SavedFeeds.set({ viewerId, readAt, preferences: layout(key) }));
}

beforeEach(() => {
  mockViewerId = 'viewer-a';
  mockGet.mockReset();
  // Unanswered unless a case answers it.
  mockGet.mockReturnValue(new Promise(() => undefined));
  accounts = createAccounts();
  seen = undefined;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  client.clear();
  setActiveStore(undefined);
});

it("shows the account's kept layout while the server has not answered", async () => {
  const store = accounts.open('viewer-a');
  keep(store, 'viewer-a', 'mine');

  await render(store);

  expect(pinned()).toEqual(['mine']);
  expect(seen?.isLoading).toBe(false);
});

it("keeps the server's answer in the account's store and shows it", async () => {
  const store = accounts.open('viewer-a');
  mockGet.mockResolvedValue(layout('server'));

  await render(store);
  await settle();

  expect(pinned()).toEqual(['server']);
  expect(withStore(store, () => SavedFeeds.get())).toMatchObject({
    viewerId: 'viewer-a',
    preferences: layout('server'),
  });
});

it('never shows a copy that names another viewer', async () => {
  const store = accounts.open('viewer-a');
  keep(store, 'viewer-b', 'theirs');

  await render(store);

  expect(pinned()).toEqual([]);
  expect(client.getQueryData(viewerQueryKeys.feedPreferences('viewer-a'))).toBeUndefined();
});

it('ignores a copy older than a week', async () => {
  const store = accounts.open('viewer-a');
  keep(store, 'viewer-a', 'ancient', Date.now() - 8 * 24 * 60 * 60 * 1000);

  await render(store);

  expect(pinned()).toEqual([]);
});

it("writes a late answer nowhere once the account's store is left", async () => {
  const store = accounts.open('viewer-a');
  let answer: (preferences: FeedPreferences) => void = () => undefined;
  mockGet.mockReturnValue(
    new Promise<FeedPreferences>((resolve) => {
      answer = resolve;
    }),
  );
  await render(store);

  const next = accounts.open('viewer-b');
  await act(async () => {
    answer(layout('late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(withStore(next, () => SavedFeeds.get())).toBeUndefined();
});
