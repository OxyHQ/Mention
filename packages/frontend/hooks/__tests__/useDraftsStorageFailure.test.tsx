import TestRenderer, { act } from 'react-test-renderer';
import { getDraftsStorageKey, useDrafts, type Draft } from '../useDrafts';

const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
const mockRemoveItem = jest.fn();
let mockViewerId: string | null = 'viewer-a';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
    setItem: (...args: unknown[]) => mockSetItem(...args),
    removeItem: (...args: unknown[]) => mockRemoveItem(...args),
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockViewerId ? { id: mockViewerId } : null }),
}));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { warn: jest.fn() },
  createLogger: () => ({ debug: jest.fn(), error: jest.fn() }),
}));

const storedDraft: Draft = {
  id: 'saved',
  postContent: 'original text',
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
function Probe() {
  latest = useDrafts();
  return null;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockViewerId = 'viewer-a';
  mockGetItem.mockResolvedValue(JSON.stringify([storedDraft]));
  mockSetItem.mockResolvedValue(undefined);
  mockRemoveItem.mockResolvedValue(undefined);
});

it('reports a failed edit and keeps the last stored draft in state', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockSetItem.mockRejectedValueOnce(new Error('storage full'));

  await act(async () => {
    await expect(latest.saveDraft({ ...storedDraft, postContent: 'new text' })).rejects.toThrow();
  });

  expect(mockSetItem).toHaveBeenCalledWith(
    getDraftsStorageKey('viewer-a'),
    expect.stringContaining('new text'),
  );
  expect(latest.drafts[0].postContent).toBe('original text');
  await act(async () => {
    await latest.saveDraft({ ...storedDraft, postContent: 'new text' });
  });
  expect(latest.drafts[0].postContent).toBe('new text');
  act(() => renderer!.unmount());
});

it('does not overwrite stored drafts when reading them for a save fails', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockGetItem.mockRejectedValueOnce(new Error('storage unavailable'));

  await act(async () => {
    await expect(latest.saveDraft({ ...storedDraft, postContent: 'new text' })).rejects.toThrow();
  });

  expect(mockSetItem).not.toHaveBeenCalled();
  expect(latest.drafts[0].postContent).toBe('original text');
  act(() => renderer!.unmount());
});

it('reports a failed delete without removing the draft from state', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockSetItem.mockRejectedValueOnce(new Error('storage unavailable'));

  await act(async () => {
    await expect(latest.deleteDraft('saved')).rejects.toThrow();
  });

  expect(latest.drafts[0].id).toBe('saved');
  await act(async () => {
    await latest.deleteDraft('saved');
  });
  expect(latest.drafts).toEqual([]);
  act(() => renderer!.unmount());
});

it('reports a failed read and recovers without replacing the previous list', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockGetItem.mockRejectedValueOnce(new Error('storage unavailable'));
  await act(async () => {
    await latest.loadDrafts();
  });
  expect(latest.isError).toBe(true);
  expect(latest.drafts[0].postContent).toBe('original text');

  await act(async () => {
    await latest.loadDrafts();
  });
  expect(latest.isError).toBe(false);
  expect(latest.drafts[0].postContent).toBe('original text');
  act(() => renderer!.unmount());
});

it('does not overwrite malformed stored data', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockGetItem.mockResolvedValueOnce('{bad json');
  await act(async () => {
    await expect(latest.saveDraft({ ...storedDraft, postContent: 'new text' })).rejects.toThrow();
  });
  expect(mockSetItem).not.toHaveBeenCalled();
  act(() => renderer!.unmount());
});

it.each(['null', '{}', 'false', '0', '""'])(
  'does not treat stored JSON %s as a missing draft list',
  async (raw) => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    mockGetItem.mockResolvedValueOnce(raw);
    await act(async () => {
      await expect(latest.saveDraft({ ...storedDraft, postContent: 'new text' })).rejects.toThrow();
    });
    expect(mockSetItem).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
  },
);

it('allows creating a draft when the storage key is actually absent', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  mockGetItem.mockResolvedValue(null);
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  await act(async () => {
    await latest.saveDraft({ ...storedDraft, postContent: 'new text' });
  });
  expect(mockSetItem).toHaveBeenCalledWith(
    getDraftsStorageKey('viewer-a'),
    expect.stringContaining('new text'),
  );
  expect(latest.drafts[0].postContent).toBe('new text');
  act(() => renderer!.unmount());
});

it('reports a failed clear and keeps the list until removal succeeds', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockRemoveItem.mockRejectedValueOnce(new Error('storage unavailable'));
  await act(async () => {
    await expect(latest.clearAllDrafts()).rejects.toThrow();
  });
  expect(latest.drafts[0].id).toBe('saved');
  await act(async () => {
    await latest.clearAllDrafts();
  });
  expect(latest.drafts).toEqual([]);
  act(() => renderer!.unmount());
});

it('does not publish a failed old-account write into the new account', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  let rejectWrite: (error: Error) => void = () => {};
  mockSetItem.mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => (rejectWrite = reject)),
  );
  let result: Promise<string | Error>;
  await act(async () => {
    result = latest
      .saveDraft({ ...storedDraft, postContent: 'old viewer edit' })
      .catch((error) => error);
  });
  expect(mockSetItem).toHaveBeenCalledWith(
    getDraftsStorageKey('viewer-a'),
    expect.stringContaining('old viewer edit'),
  );

  mockViewerId = 'viewer-b';
  mockGetItem.mockResolvedValue(JSON.stringify([{ ...storedDraft, id: 'viewer-b-draft' }]));
  await act(async () => {
    renderer!.update(<Probe />);
  });
  await act(async () => {
    rejectWrite(new Error('storage unavailable'));
    expect(await result!).toBeInstanceOf(Error);
  });
  expect(latest.drafts.map((draft) => draft.id)).toEqual(['viewer-b-draft']);
  expect(mockSetItem).not.toHaveBeenCalledWith(getDraftsStorageKey('viewer-b'), expect.anything());
  act(() => renderer!.unmount());
});

it('does not delete from either account when the owner changes during the read', async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  let finishRead: (value: string) => void = () => {};
  mockGetItem.mockImplementationOnce(
    () => new Promise<string>((resolve) => (finishRead = resolve)),
  );
  let result: Promise<void | Error>;
  await act(async () => {
    result = latest.deleteDraft('saved').catch((error) => error);
  });

  mockViewerId = 'viewer-b';
  mockGetItem.mockResolvedValue(JSON.stringify([{ ...storedDraft, id: 'viewer-b-draft' }]));
  await act(async () => {
    renderer!.update(<Probe />);
  });
  await act(async () => {
    finishRead(JSON.stringify([storedDraft]));
    expect(await result!).toBeInstanceOf(Error);
  });
  expect(mockSetItem).not.toHaveBeenCalled();
  expect(latest.drafts.map((draft) => draft.id)).toEqual(['viewer-b-draft']);
  act(() => renderer!.unmount());
});
