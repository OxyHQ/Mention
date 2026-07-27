const mockGet = jest.fn();
const mockPut = jest.fn();
const mockInvalidateQueries = jest.fn();

jest.mock('@/utils/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
  publicApi: {
    get: jest.fn(),
  },
  isUnauthorizedError: () => false,
}));

jest.mock('@/lib/queryClient', () => ({
  queryClient: {
    invalidateQueries: (...args: unknown[]) => mockInvalidateQueries(...args),
  },
}));

// Install API mocks before loading the singleton store module.
// eslint-disable-next-line import/first
import { useAppearanceStore, type UserAppearance } from '../appearanceStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const appearance = (viewerId: string, primaryColor: string): UserAppearance => ({
  oxyUserId: viewerId,
  appearance: {
    themeMode: 'system',
    primaryColor,
  },
});

describe('appearanceStore viewer isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAppearanceStore.getState().resetViewerState();
  });

  it('discards A settings when its load resolves after B', async () => {
    const pendingA = deferred<{ data: UserAppearance }>();
    const pendingB = deferred<{ data: UserAppearance }>();
    mockGet
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);

    const requestA = useAppearanceStore.getState().loadMySettings(true);
    useAppearanceStore.getState().resetViewerState();
    const requestB = useAppearanceStore.getState().loadMySettings(true);

    pendingB.resolve({ data: appearance('viewer-b', '#bbbbbb') });
    await requestB;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId)
      .toBe('viewer-b');

    pendingA.resolve({ data: appearance('viewer-a', '#aaaaaa') });
    await requestA;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId)
      .toBe('viewer-b');
  });

  it('does not let a late A update overwrite B settings', async () => {
    const pendingA = deferred<{ data: UserAppearance }>();
    const pendingB = deferred<{ data: UserAppearance }>();
    mockPut
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);

    const requestA = useAppearanceStore
      .getState()
      .updateMySettings({ appearance: { primaryColor: '#aaaaaa' } });
    useAppearanceStore.getState().resetViewerState();
    const requestB = useAppearanceStore
      .getState()
      .updateMySettings({ appearance: { primaryColor: '#bbbbbb' } });

    pendingB.resolve({ data: appearance('viewer-b', '#bbbbbb') });
    await requestB;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId)
      .toBe('viewer-b');

    pendingA.resolve({ data: appearance('viewer-a', '#aaaaaa') });
    await requestA;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId)
      .toBe('viewer-b');
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
  });
});
