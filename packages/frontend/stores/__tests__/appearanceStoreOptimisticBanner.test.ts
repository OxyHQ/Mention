type InvalidationPredicate = (query: { queryKey: readonly unknown[] }) => boolean;

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockInvalidateQueries = jest.fn();
// The predicate the store hands to React Query, captured so a test can RUN it
// against real keys. Asserting only that `invalidateQueries` was called cannot
// tell a correct predicate from one that matches nothing.
let mockCapturedPredicate: InvalidationPredicate | null = null;

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
    invalidateQueries: (
      options: { predicate?: (query: { queryKey: readonly unknown[] }) => boolean },
    ) => {
      mockInvalidateQueries(options);
      mockCapturedPredicate = options.predicate ?? null;
    },
  },
}));

// Install API mocks before loading the singleton store module.
// eslint-disable-next-line import/first
import { useAppearanceStore, type UserAppearance } from '../appearanceStore';
// eslint-disable-next-line import/first
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const stored: UserAppearance = {
  oxyUserId: 'viewer-a',
  appearance: { themeMode: 'system', primaryColor: '#aaaaaa' },
  profileHeaderImage: 'old-banner-file',
  profileCustomization: { coverPhotoEnabled: true, minimalistMode: false },
};

function seedStoredSettings(): void {
  useAppearanceStore.setState({ mySettings: { ...stored }, loading: false, error: null });
}

/**
 * The picked banner must paint on the tap, not two round trips later — the write
 * goes to Mention and Mention's own write goes on to Oxy, so waiting for the
 * response is what made the edit screen feel like it had ignored the pick.
 */
describe('appearanceStore optimistic banner echo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCapturedPredicate = null;
    useAppearanceStore.getState().resetViewerState();
  });

  it('shows the picked banner before the save resolves', async () => {
    seedStoredSettings();
    const pending = deferred<{ data: UserAppearance }>();
    mockPut.mockReturnValueOnce(pending.promise);

    const request = useAppearanceStore
      .getState()
      .updateMySettings({ profileHeaderImage: 'new-banner-file' });

    expect(useAppearanceStore.getState().mySettings?.profileHeaderImage)
      .toBe('new-banner-file');

    pending.resolve({ data: { ...stored, profileHeaderImage: 'new-banner-file' } });
    await request;

    expect(useAppearanceStore.getState().mySettings?.profileHeaderImage)
      .toBe('new-banner-file');
  });

  it('clears the preview immediately when the banner is removed', async () => {
    seedStoredSettings();
    const pending = deferred<{ data: UserAppearance }>();
    mockPut.mockReturnValueOnce(pending.promise);

    const request = useAppearanceStore
      .getState()
      .updateMySettings({ profileHeaderImage: '' });

    expect(useAppearanceStore.getState().mySettings?.profileHeaderImage)
      .toBeUndefined();

    pending.resolve({ data: { ...stored, profileHeaderImage: undefined } });
    await request;
  });

  it('rolls back to the stored banner when the save fails', async () => {
    seedStoredSettings();
    const pending = deferred<{ data: UserAppearance }>();
    mockPut.mockReturnValueOnce(pending.promise);

    const request = useAppearanceStore
      .getState()
      .updateMySettings({ profileHeaderImage: 'new-banner-file' });

    expect(useAppearanceStore.getState().mySettings?.profileHeaderImage)
      .toBe('new-banner-file');

    pending.reject(new Error('network down'));
    await request;

    expect(useAppearanceStore.getState().mySettings?.profileHeaderImage)
      .toBe('old-banner-file');
    expect(useAppearanceStore.getState().error).toBe('network down');
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('does not echo profileMedia, whose metadata only the server can resolve', async () => {
    seedStoredSettings();
    const pending = deferred<{ data: UserAppearance }>();
    mockPut.mockReturnValueOnce(pending.promise);

    const request = useAppearanceStore
      .getState()
      .updateMySettings({ profileMedia: { type: 'podcast', syraPodcastId: 'show-1' } });

    expect(useAppearanceStore.getState().mySettings?.profileMedia).toBeUndefined();

    pending.resolve({ data: stored });
    await request;
  });

  /**
   * The optimistic echo only reaches surfaces that subscribe to this store — the
   * edit-screen preview. The PROFILE screen reads the same appearance payload
   * through React Query (`useProfileData` → `viewerQueryKeys.appearanceForUser`)
   * behind a 5-minute staleTime, so the save must invalidate that entry or the
   * profile keeps painting the pre-edit banner. Run the predicate the store
   * actually passes against the key the hook actually builds: a call-count
   * assertion would pass just as happily on a predicate that matches nothing.
   */
  it('invalidates the exact appearance entry the profile screen reads', async () => {
    seedStoredSettings();
    mockPut.mockResolvedValueOnce({
      data: { ...stored, profileHeaderImage: 'new-banner-file' },
    });

    await useAppearanceStore
      .getState()
      .updateMySettings({ profileHeaderImage: 'new-banner-file' });

    const predicate = mockCapturedPredicate;
    if (typeof predicate !== 'function') {
      throw new Error('updateMySettings passed no predicate to invalidateQueries');
    }

    // The owner viewing their own profile, and any other viewer's copy of it:
    // the payload is privacy-gated per viewer, so every variant must be dropped.
    expect(predicate({
      queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'viewer-a'),
    })).toBe(true);
    expect(predicate({
      queryKey: viewerQueryKeys.appearanceForUser('someone-else', 'viewer-a'),
    })).toBe(true);

    // ...and nothing else: not another owner's appearance, not another family.
    expect(predicate({
      queryKey: viewerQueryKeys.appearanceForUser('viewer-a', 'other-owner'),
    })).toBe(false);
    expect(predicate({
      queryKey: viewerQueryKeys.notifications('viewer-a'),
    })).toBe(false);
  });

  it('does not invalidate the profile entry when the save fails', async () => {
    seedStoredSettings();
    mockPut.mockRejectedValueOnce(new Error('network down'));

    await useAppearanceStore
      .getState()
      .updateMySettings({ profileHeaderImage: 'new-banner-file' });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });

  it('keeps a failed save from restoring the previous account settings', async () => {
    seedStoredSettings();
    const pending = deferred<{ data: UserAppearance }>();
    mockPut.mockReturnValueOnce(pending.promise);

    const request = useAppearanceStore
      .getState()
      .updateMySettings({ profileHeaderImage: 'new-banner-file' });

    // The viewer switches away mid-flight; the store is cleared for the next
    // account. A rollback here would republish account A's banner.
    useAppearanceStore.getState().resetViewerState();

    pending.reject(new Error('network down'));
    await request;

    expect(useAppearanceStore.getState().mySettings).toBeNull();
    expect(useAppearanceStore.getState().error).toBeNull();
  });
});
