const mockPut = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockFetchViewerSettings = jest.fn();

jest.mock('@/utils/api', () => ({
  api: {
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
    setQueryData: jest.fn(),
  },
}));

jest.mock('@/lib/viewerSettings', () => ({
  fetchViewerSettings: (...args: unknown[]) => mockFetchViewerSettings(...args),
}));

// Install API mocks before loading the singleton store module.
import { useAppearanceStore, type UserAppearance } from '../appearanceStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const appearance = (viewerId: string, postTextExpand: 'more' | 'all'): UserAppearance => ({
  oxyUserId: viewerId,
  appearance: {
    themeMode: 'system',
    postTextExpand,
  },
});

describe('appearanceStore viewer isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAppearanceStore.getState().resetViewerState();
  });

  it('discards A settings when its load resolves after B', async () => {
    const pendingA = deferred<UserAppearance>();
    const pendingB = deferred<UserAppearance>();
    mockFetchViewerSettings
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);

    const requestA = useAppearanceStore.getState().loadMySettings('viewer-a');
    useAppearanceStore.getState().resetViewerState();
    const requestB = useAppearanceStore.getState().loadMySettings('viewer-b');
    expect(mockFetchViewerSettings).toHaveBeenLastCalledWith('viewer-b');

    pendingB.resolve(appearance('viewer-b', 'all'));
    await requestB;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId).toBe('viewer-b');

    pendingA.resolve(appearance('viewer-a', 'more'));
    await requestA;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId).toBe('viewer-b');
  });

  it('reloads, without an id, only for the viewer it last loaded', async () => {
    await useAppearanceStore.getState().loadMySettings();
    expect(mockFetchViewerSettings).not.toHaveBeenCalled();

    mockFetchViewerSettings.mockResolvedValue(appearance('viewer-a', 'more'));
    await useAppearanceStore.getState().loadMySettings('viewer-a');
    await useAppearanceStore.getState().loadMySettings();
    expect(mockFetchViewerSettings).toHaveBeenLastCalledWith('viewer-a');
    expect(mockFetchViewerSettings).toHaveBeenCalledTimes(2);
  });

  it('does not let a late A update overwrite B settings', async () => {
    const pendingA = deferred<{ data: UserAppearance }>();
    const pendingB = deferred<{ data: UserAppearance }>();
    mockPut.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);

    const requestA = useAppearanceStore
      .getState()
      .updateMySettings({ appearance: { postTextExpand: 'more' } });
    useAppearanceStore.getState().resetViewerState();
    const requestB = useAppearanceStore
      .getState()
      .updateMySettings({ appearance: { postTextExpand: 'all' } });

    pendingB.resolve({ data: appearance('viewer-b', 'all') });
    await requestB;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId).toBe('viewer-b');

    pendingA.resolve({ data: appearance('viewer-a', 'more') });
    await requestA;
    expect(useAppearanceStore.getState().mySettings?.oxyUserId).toBe('viewer-b');
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);
  });
});
