import TestRenderer, { act } from 'react-test-renderer';
import { getDraftsStorageKey, useDrafts, type Draft } from '../useDrafts';
const mockStore = new Map<string, string>();
let mockViewerId = 'viewer-a';
let mockPauseRead = false;
let mockReleaseRead: () => void = () => {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => {
      const snapshot = mockStore.get(key) ?? null;
      if (mockPauseRead && key === '@mention_drafts:v2:viewer-a') {
        mockPauseRead = false;
        return new Promise<string | null>((resolve) => {
          mockReleaseRead = () => resolve(snapshot);
        });
      }
      return Promise.resolve(snapshot);
    },
    setItem: (key: string, value: string) => {
      mockStore.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      mockStore.delete(key);
      return Promise.resolve();
    },
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockViewerId } }),
}));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { warn: jest.fn() },
  createLogger: () => ({ debug: jest.fn(), error: jest.fn() }),
}));
const existing: Draft = {
  id: 'saved',
  postContent: 'original',
  mediaIds: [],
  pollOptions: [],
  showPollCreator: false,
  location: null,
  mentions: [],
  threadItems: [],
  postingMode: 'thread',
  createdAt: 1,
  updatedAt: 1,
};
let latest: ReturnType<typeof useDrafts>;
const session = (id: string, revision: number | null) => ({
  id,
  revision,
  closed: false,
  conflicted: false,
});
function Probe() {
  latest = useDrafts();
  return null;
}
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
it('retains a new A-session draft when an older A-session read completes late', async () => {
  mockStore.set(getDraftsStorageKey('viewer-a'), JSON.stringify([existing]));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe key="a1" />);
  });
  mockPauseRead = true;
  let oldSave!: Promise<string>;
  await act(async () => {
    oldSave = latest.saveDraft({ ...existing, postContent: 'old A edit' }, session('saved', 0));
  });
  mockViewerId = 'viewer-b';
  await act(async () => {
    renderer.update(<Probe key="b" />);
  });
  mockViewerId = 'viewer-a';
  await act(async () => {
    renderer.update(<Probe key="a2" />);
  });
  let newSave!: Promise<string>;
  await act(async () => {
    newSave = latest.saveDraft(
      { ...existing, id: 'new-a-draft', postContent: 'new A work' },
      session('new-a-draft', null),
    );
  });
  await act(async () => {
    mockReleaseRead();
    await Promise.all([oldSave, newSave]);
  });
  expect(
    JSON.parse(mockStore.get(getDraftsStorageKey('viewer-a'))!).map((d: Draft) => d.id),
  ).toContain('new-a-draft');
  act(() => renderer.unmount());
});

it.each(['delete', 'clear'] as const)(
  'orders a save before %s from another instance',
  async (operation) => {
    mockViewerId = 'viewer-a';
    mockStore.clear();
    mockStore.set(getDraftsStorageKey('viewer-a'), JSON.stringify([existing]));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe key="first" />);
    });
    const first = latest;
    mockPauseRead = true;
    let save!: Promise<string>;
    await act(async () => {
      save = first.saveDraft(
        { ...existing, id: 'new', postContent: 'new work' },
        session('new', null),
      );
    });
    await act(async () => {
      renderer.update(
        <>
          <Probe key="first" />
          <Probe key="second" />
        </>,
      );
    });
    let removal!: Promise<void>;
    await act(async () => {
      removal = operation === 'delete' ? latest.deleteDraft('saved', 0) : latest.clearAllDrafts();
    });
    await act(async () => {
      mockReleaseRead();
      await Promise.all([save, removal]);
    });
    const value = mockStore.get(getDraftsStorageKey('viewer-a'));
    if (operation === 'delete')
      expect(JSON.parse(value!).map((draft: Draft) => draft.id)).toEqual(['new']);
    else expect(value).toBeUndefined();
    act(() => renderer.unmount());
  },
);

it('does not let a previous session deletion erase a newer edit of the same draft', async () => {
  mockViewerId = 'viewer-a';
  mockStore.clear();
  mockStore.set(getDraftsStorageKey('viewer-a'), JSON.stringify([existing]));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe key="a1" />);
  });
  mockPauseRead = true;
  let deletion!: Promise<void>;
  await act(async () => {
    deletion = latest.deleteDraft('saved', 0);
  });
  mockViewerId = 'viewer-b';
  await act(async () => renderer.update(<Probe key="b" />));
  mockViewerId = 'viewer-a';
  await act(async () => renderer.update(<Probe key="a2" />));
  let save!: Promise<string>;
  await act(async () => {
    save = latest.saveDraft({ ...existing, postContent: 'newest edit' }, session('saved', 0));
  });
  await act(async () => {
    mockReleaseRead();
    await deletion;
    await expect(save).rejects.toMatchObject({ name: 'DraftConflictError' });
  });
  expect(JSON.parse(mockStore.get(getDraftsStorageKey('viewer-a'))!)).toEqual([]);
  act(() => renderer.unmount());
});
