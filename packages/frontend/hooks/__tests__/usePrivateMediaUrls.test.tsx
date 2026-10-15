import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePrivateMediaUrls } from '../usePrivateMediaUrls';

const mockUrls = jest.fn();
const mockAuth = {
  user: { id: 'alice' },
  canUsePrivateApi: true,
  oxyServices: { assets: { urls: mockUrls } },
};
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
let client: QueryClient;
let renderer: ReactTestRenderer;
let resolve: ReturnType<typeof usePrivateMediaUrls>;
function Probe({ ids }: { ids: readonly string[] }) {
  resolve = usePrivateMediaUrls(ids);
  return null;
}
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
  });
}
async function render(ids: readonly string[]) {
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe ids={ids} />
      </QueryClientProvider>,
    );
  });
  await settle();
}
async function update(ids: readonly string[]) {
  await act(async () =>
    renderer.update(
      <QueryClientProvider client={client}>
        <Probe ids={ids} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user = { id: 'alice' };
  mockAuth.canUsePrivateApi = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockUrls.mockImplementation(async (requests: { fileId: string }[]) =>
    Object.fromEntries(
      requests.map(({ fileId }) => [fileId, `https://scoped.example/alice/${fileId}`]),
    ),
  );
});
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
});

it('deduplicates asset IDs into bounded calls and never invents a public fallback for missing files', async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `file-${index}`);
  await render([...ids, ids[0], '', 'https://external.example/owned-image.png']);
  expect(mockUrls.mock.calls.map(([requests]) => requests.length)).toEqual([100, 1]);
  expect(mockUrls.mock.calls.every(([, options]) => options.context === 'mention-compose')).toBe(
    true,
  );
  expect(
    new Set(
      mockUrls.mock.calls.flatMap(([requests]) =>
        requests.map(({ fileId }: { fileId: string }) => fileId),
      ),
    ).size,
  ).toBe(101);
  expect(resolve('file-0')).toBe('https://scoped.example/alice/file-0');
  expect(resolve('missing')).toBe('');
  expect(resolve('https://external.example/owned-image.png')).toBe(
    'https://external.example/owned-image.png',
  );
});

it('waits for the private session and removes the previous account URL while the next request is pending', async () => {
  mockAuth.canUsePrivateApi = false;
  await render(['file']);
  expect(mockUrls).not.toHaveBeenCalled();
  expect(resolve('file')).toBe('');
  mockAuth.canUsePrivateApi = true;
  await update(['file']);
  expect(resolve('file')).toBe('https://scoped.example/alice/file');
  let complete!: (value: Record<string, string>) => void;
  mockUrls.mockImplementationOnce(
    () =>
      new Promise((done) => {
        complete = done;
      }),
  );
  mockAuth.user = { id: 'bob' };
  await update(['file']);
  expect(resolve('file')).toBe('');
  await act(async () => complete({ file: 'https://scoped.example/bob/file' }));
  await settle();
  expect(resolve('file')).toBe('https://scoped.example/bob/file');
  mockAuth.canUsePrivateApi = false;
  await update(['file']);
  expect(resolve('file')).toBe('');
});

it('hides retained scoped URLs when a current access check is denied', async () => {
  await render(['file']);
  expect(resolve('file')).toBe('https://scoped.example/alice/file');
  mockUrls.mockRejectedValueOnce(Object.assign(new Error('Access revoked'), { status: 403 }));
  await act(async () => {
    await client.refetchQueries();
  });
  await settle();
  expect(resolve('file')).toBe('');
  expect(mockUrls).toHaveBeenCalledTimes(2);
});
