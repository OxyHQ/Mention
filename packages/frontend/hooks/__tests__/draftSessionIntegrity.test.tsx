import TestRenderer, { act } from 'react-test-renderer';
import { useDrafts, type Draft } from '../useDrafts';
import { useDraftManager, type ComposeDraftRefs } from '../useDraftManager';
import { createVariantsState } from '@/utils/composeVariants';
import { prepareDraftSwitch } from '@/utils/prepareDraftSwitch';

let mockViewer = 'viewer-a';
const mockData = new Map<string, Draft[]>();
const mockEvents: string[] = [];
const mockAttemptedIds: string[] = [];
let mockBlockNextWrite = false;
let mockReleaseWrite: () => void = () => {};
let mockWriteStarted: () => void = () => {};
let mockFailNextWrite = false;
const mockStorage = {
  get: async (key: string) => (mockData.has(key) ? structuredClone(mockData.get(key)) : null),
  getStrict: async (key: string) =>
    mockData.has(key)
      ? { found: true, value: structuredClone(mockData.get(key)) }
      : { found: false },
  set: async (key: string, value: Draft[]) => {
    mockAttemptedIds.push(value[0]?.id ?? '');
    if (mockBlockNextWrite) {
      mockBlockNextWrite = false;
      mockWriteStarted();
      await new Promise<void>((resolve) => {
        mockReleaseWrite = resolve;
      });
    }
    if (mockFailNextWrite) {
      mockFailNextWrite = false;
      return false;
    }
    mockData.set(key, structuredClone(value));
    mockEvents.push(JSON.stringify(value.map((d) => [d.id, d.postContent])));
    return true;
  },
  remove: async (key: string) => {
    mockData.delete(key);
    return true;
  },
};
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: mockViewer } }) }));
jest.mock('@/utils/storage', () => ({
  Storage: {
    get: (...args: [string]) => mockStorage.get(...args),
    getStrict: (...args: [string]) => mockStorage.getStrict(...args),
    set: (...args: [string, Draft[]]) => mockStorage.set(...args),
    remove: (...args: [string]) => mockStorage.remove(...args),
  },
}));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { error: jest.fn() },
  createLogger: () => ({ debug: jest.fn(), error: jest.fn() }),
}));

const key = '@mention_drafts:v2:viewer-a';
const draft = (id: string, text: string): Draft => ({
  id,
  postContent: text,
  mediaIds: [],
  pollOptions: [],
  showPollCreator: false,
  location: null,
  mentions: [],
  threadItems: [],
  postingMode: 'thread',
  createdAt: 1,
  updatedAt: 1,
});
function firstStoredDraft(): Draft {
  const draft = mockData.get(key)?.[0];
  if (!draft) throw new Error('expected a stored draft');
  return structuredClone(draft);
}
let latest!: ReturnType<typeof useDraftManager>;
function Probe() {
  const { saveDraft, queueDeleteDraft } = useDrafts();
  latest = useDraftManager({ saveDraft, queueDeleteDraft, onDraftLoad: () => {} });
  return null;
}
const refs = (text: string): ComposeDraftRefs => ({
  postContent: text,
  mediaIds: [],
  pollOptions: [],
  pollTitle: '',
  showPollCreator: false,
  location: null,
  sources: [],
  article: null,
  event: null,
  room: null,
  podcast: null,
  job: null,
  threadItems: [],
  mentions: [],
  postingMode: 'thread',
  attachmentOrder: [],
  scheduledAt: null,
  currentDraftId: null,
  variants: createVariantsState('en'),
});

type DraftManager = ReturnType<typeof useDraftManager>;
type DraftStorage = ReturnType<typeof useDrafts>;

function createPairProbe(
  report: (
    first: DraftManager,
    second: DraftManager,
    firstStorage: DraftStorage,
    secondStorage: DraftStorage,
  ) => void,
) {
  return function Pair() {
    const one = useDrafts();
    const two = useDrafts();
    const first = useDraftManager({
      saveDraft: one.saveDraft,
      queueDeleteDraft: one.queueDeleteDraft,
      onDraftLoad: () => {},
    });
    const second = useDraftManager({
      saveDraft: two.saveDraft,
      queueDeleteDraft: two.queueDeleteDraft,
      onDraftLoad: () => {},
    });
    report(first, second, one, two);
    return null;
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  mockAttemptedIds.length = 0;
  mockBlockNextWrite = false;
  mockFailNextWrite = false;
  mockWriteStarted = () => {};
  mockReleaseWrite = () => {};
});

it('does not overwrite a different draft when a previous save completes after loading it', async () => {
  const a = draft('a', 'old A'),
    b = draft('b', 'old B');
  mockData.set(key, [a, b]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  act(() => latest.loadDraft(a));
  mockBlockNextWrite = true;
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  mockWriteStarted = writeStarted;
  let saveA!: Promise<void>;
  await act(async () => {
    saveA = latest.autoSave(refs('edited A'));
    await started;
  });
  act(() => latest.loadDraft(b));
  expect(latest.currentDraftId).toBe('b');
  await act(async () => {
    mockReleaseWrite();
    await saveA;
  });
  await act(async () => {
    await latest.autoSave(refs('edited B'));
  });
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('edited A');
  expect(mockData.get(key)?.find((d) => d.id === 'b')?.postContent).toBe('edited B');
  act(() => renderer.unmount());
});

it('does not let an old discarded session delete a newer same-account edit after account switching', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  mockAttemptedIds.length = 0;
  const a = draft('a', 'stored original');
  mockData.set(key, [a]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe key="old-a" />);
  });
  act(() => latest.loadDraft(a));
  mockBlockNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let oldSave!: Promise<void>, discard!: Promise<void>;
  await act(async () => {
    oldSave = latest.autoSave(refs('old edit'));
    await started;
  });
  act(() => {
    discard = latest.discard();
  });
  mockViewer = 'viewer-b';
  await act(async () => renderer.update(<Probe key="b" />));
  mockViewer = 'viewer-a';
  await act(async () => renderer.update(<Probe key="new-a" />));
  act(() => latest.loadDraft(a));
  let newSave!: Promise<void>;
  act(() => {
    newSave = latest.autoSave(refs('new A edit'));
  });
  await act(async () => {
    mockReleaseWrite();
    await Promise.all([oldSave, discard, newSave]);
  });
  expect(latest.draftConflict).toBe(true);
  await act(async () => {
    await latest.saveAsCopy(refs('new A edit'));
  });
  expect(mockData.get(key)?.find((d) => d.id === latest.currentDraftId)?.postContent).toBe(
    'new A edit',
  );
  act(() => renderer.unmount());
});

it('keeps queued A snapshots owned by A when B opens during a save', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A'),
    b = draft('b', 'old B');
  mockData.set(key, [a, b]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  act(() => latest.loadDraft(a));
  mockBlockNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let first!: Promise<void>, queued!: Promise<void>;
  await act(async () => {
    first = latest.autoSave(refs('A first'));
    await started;
  });
  act(() => {
    queued = latest.autoSave(refs('A latest'));
    latest.loadDraft(b);
  });
  await act(async () => {
    mockReleaseWrite();
    await Promise.all([first, queued]);
  });
  expect(latest.currentDraftId).toBe('b');
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('A latest');
  expect(mockData.get(key)?.find((d) => d.id === 'b')?.postContent).toBe('old B');
  act(() => renderer.unmount());
});

it('does not leave an orphan when discarding while the first draft is still being created', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  mockBlockNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let first!: Promise<void>, discard!: Promise<void>;
  await act(async () => {
    first = latest.autoSave(refs('new draft'));
    await started;
  });
  act(() => {
    discard = latest.discard();
  });
  await act(async () => {
    mockReleaseWrite();
    await Promise.all([first, discard]);
  });
  expect(mockData.get(key) ?? []).toEqual([]);
  expect(latest.currentDraftId).toBeNull();
  act(() => renderer.unmount());
});

it('does not attribute a failed old-session save to the draft opened afterward', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A'),
    b = draft('b', 'old B');
  mockData.set(key, [a, b]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  act(() => latest.loadDraft(a));
  mockBlockNextWrite = true;
  mockFailNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let first!: Promise<void>;
  await act(async () => {
    first = latest.autoSave(refs('A edit'));
    await started;
  });
  act(() => latest.loadDraft(b));
  await act(async () => {
    mockReleaseWrite();
    await first;
  });
  expect(latest.currentDraftId).toBe('b');
  expect(latest.autoSaveError).toBe(false);
  act(() => renderer.unmount());
});

it('cancels queued snapshots on discard before a new session saves the same ID', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'stored A');
  mockData.set(key, [a]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe key="old" />);
  });
  act(() => latest.loadDraft(a));
  mockBlockNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let first!: Promise<void>, queued!: Promise<void>, discard!: Promise<void>;
  await act(async () => {
    first = latest.autoSave(refs('old A'));
    await started;
  });
  act(() => {
    queued = latest.autoSave(refs('queued old A'));
    discard = latest.discard();
  });
  mockViewer = 'viewer-b';
  await act(async () => renderer.update(<Probe key="b" />));
  mockViewer = 'viewer-a';
  await act(async () => renderer.update(<Probe key="new" />));
  act(() => latest.loadDraft(a));
  let newer!: Promise<void>;
  act(() => {
    newer = latest.autoSave(refs('new A'));
  });
  await act(async () => {
    mockReleaseWrite();
    await Promise.all([first, queued, discard, newer]);
  });
  expect(latest.draftConflict).toBe(true);
  await act(async () => {
    await latest.saveAsCopy(refs('new A'));
  });
  expect(mockData.get(key)?.find((d) => d.id === latest.currentDraftId)?.postContent).toBe('new A');
  act(() => renderer.unmount());
});

it('leaves a newer autosave armed when switching is cancelled because the editor changed', async () => {
  jest.useFakeTimers();
  try {
    mockViewer = 'viewer-a';
    mockData.clear();
    const a = draft('a', 'old A');
    mockData.set(key, [a]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });
    act(() => latest.loadDraft(a));
    mockBlockNextWrite = true;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    mockWriteStarted = start;
    let current = refs('first A');
    let switching!: ReturnType<typeof prepareDraftSwitch>;
    await act(async () => {
      switching = prepareDraftSwitch(
        'b',
        () => current,
        latest.getDraftSession,
        latest.saveNow,
        async () => draft('b', 'B'),
        () => true,
      );
      await started;
    });
    current = refs('new A');
    act(() => {
      latest.autoSaveTimeoutRef.current = setTimeout(() => {
        void latest.autoSave(current);
      }, 2000);
    });
    await act(async () => {
      mockReleaseWrite();
      expect(await switching).toEqual({ status: 'changed' });
    });
    expect(latest.autoSaveTimeoutRef.current).not.toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
    act(() => renderer.unmount());
  } finally {
    jest.useRealTimers();
  }
});

it('retries a failed first save under the same reserved ID and clears the warning only on success', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  mockAttemptedIds.length = 0;
  mockFailNextWrite = true;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  await act(async () => {
    await latest.autoSave(refs('new text'));
  });
  expect(latest.currentDraftId).toBeNull();
  expect(latest.autoSaveError).toBe(true);
  await act(async () => {
    await latest.autoSave(refs('new text'));
  });
  expect(latest.autoSaveError).toBe(false);
  expect(mockData.get(key)).toHaveLength(1);
  expect(mockData.get(key)?.[0].id).toBe(latest.currentDraftId);
  expect(mockAttemptedIds).toHaveLength(2);
  expect(mockAttemptedIds[0]).toBe(mockAttemptedIds[1]);
  act(() => renderer.unmount());
});

it.each(['edit', 'delete'] as const)(
  'preserves a %s to B made after a stale B snapshot was captured',
  async (change) => {
    mockViewer = 'viewer-a';
    mockData.clear();
    const a = draft('a', 'A'),
      b = draft('b', 'old B');
    mockData.set(key, [a, b]);
    let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
    const Pair = createPairProbe((a, b) => {
      first = a;
      second = b;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Pair />);
    });
    act(() => {
      first.loadDraft(a);
      second.loadDraft(b);
    });
    if (change === 'edit')
      await act(async () => {
        await second.autoSave(refs('new B'));
      });
    else
      await act(async () => {
        await second.discard();
      });
    act(() => first.loadDraft(b));
    await act(async () => {
      await first.autoSave(refs('old B'));
    });
    expect(first.draftConflict).toBe(true);
    expect(mockData.get(key)?.find((d) => d.id === 'b')?.postContent).toBe(
      change === 'edit' ? 'new B' : undefined,
    );
    act(() => renderer.unmount());
  },
);

it('saves work as a new copy after consecutive same-draft conflicts', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const original = draft('a', 'old A');
  mockData.set(key, [original]);
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(original);
    second.loadDraft(original);
  });
  await act(async () => {
    await first.autoSave(refs('new A'));
  });
  await act(async () => {
    await second.autoSave(refs('my unsaved A'));
  });
  expect(second.draftConflict).toBe(true);
  await act(async () => {
    await second.saveAsCopy(refs('my unsaved A'));
  });
  expect(second.draftConflict).toBe(false);
  const copyId = second.currentDraftId;
  expect(copyId).not.toBe('a');
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  expect(mockData.get(key)?.find((d) => d.id === copyId)?.postContent).toBe('my unsaved A');
  const firstCopy = mockData.get(key)?.find((d) => d.id === copyId);
  if (!firstCopy) throw new Error('copy missing');
  act(() => first.loadDraft(firstCopy));
  await act(async () => {
    await first.autoSave(refs('another editor changed the copy'));
  });
  await act(async () => {
    await second.autoSave(refs('another unsaved A'));
  });
  expect(second.draftConflict).toBe(true);
  await act(async () => {
    await second.saveAsCopy(refs('another unsaved A'));
  });
  expect(second.currentDraftId).not.toBe(copyId);
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  expect(mockData.get(key)?.find((d) => d.id === copyId)?.postContent).toBe(
    'another editor changed the copy',
  );
  expect(mockData.get(key)?.find((d) => d.id === second.currentDraftId)?.postContent).toBe(
    'another unsaved A',
  );
  act(() => renderer.unmount());
});

it('does not delete a newer edit from a stale list row', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let writer!: ReturnType<typeof useDraftManager>, list!: ReturnType<typeof useDrafts>;
  const Pair = createPairProbe((a, _b, _one, two) => {
    writer = a;
    list = two;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => writer.loadDraft(a));
  await act(async () => {
    await writer.autoSave(refs('new A'));
  });
  await act(async () => {
    await expect(list.deleteDraft('a', 0)).rejects.toMatchObject({ name: 'DraftConflictError' });
  });
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  act(() => renderer.unmount());
});

it('does not remove a newer draft or misreport publication when cleanup conflicts', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('new A'));
  });
  await act(async () => {
    second.beginPublish();
    await expect(second.publishSucceeded()).resolves.toBeUndefined();
    second.endPublish();
  });
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  act(() => renderer.unmount());
});

it.each(['edit', 'delete'] as const)(
  'reads the current target after an intervening %s before opening it',
  async (change) => {
    mockViewer = 'viewer-a';
    mockData.clear();
    const a = draft('a', 'A'),
      b = draft('b', 'old B');
    mockData.set(key, [a, b]);
    let first!: ReturnType<typeof useDraftManager>,
      second!: ReturnType<typeof useDraftManager>,
      firstStorage!: ReturnType<typeof useDrafts>;
    const Pair = createPairProbe((a, b, one) => {
      first = a;
      second = b;
      firstStorage = one;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Pair />);
    });
    act(() => {
      first.loadDraft(a);
      second.loadDraft(b);
    });
    mockBlockNextWrite = true;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    mockWriteStarted = start;
    const original = refs('edited A');
    let switching!: ReturnType<typeof prepareDraftSwitch>, other!: Promise<void>;
    await act(async () => {
      switching = prepareDraftSwitch(
        'b',
        () => original,
        first.getDraftSession,
        first.saveNow,
        firstStorage.readDraft,
        () => true,
      );
      await started;
    });
    act(() => {
      other = change === 'edit' ? second.autoSave(refs('new B')) : second.discard();
    });
    let result!: Awaited<ReturnType<typeof prepareDraftSwitch>>;
    await act(async () => {
      mockReleaseWrite();
      [result] = await Promise.all([switching, other]);
    });
    if (change === 'edit') {
      expect(result.status).toBe('ready');
      if (result.status !== 'ready') throw new Error('target not ready');
      expect(result.draft.postContent).toBe('new B');
      const selectedDraft = result.draft;
      act(() => first.loadDraft(selectedDraft));
      await act(async () => {
        await first.autoSave(refs('new B'));
      });
      expect(mockData.get(key)?.find((d) => d.id === 'b')?.postContent).toBe('new B');
    } else expect(result.status).toBe('missing');
    act(() => renderer.unmount());
  },
);

it.each(['edit', 'delete'] as const)(
  'rejects a stale write when B is %s after a fresh read',
  async (change) => {
    mockViewer = 'viewer-a';
    mockData.clear();
    const a = draft('a', 'A'),
      b = draft('b', 'old B');
    mockData.set(key, [a, b]);
    let first!: ReturnType<typeof useDraftManager>,
      second!: ReturnType<typeof useDraftManager>,
      one!: ReturnType<typeof useDrafts>;
    const Pair = createPairProbe((a, b, storage) => {
      first = a;
      second = b;
      one = storage;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Pair />);
    });
    act(() => {
      first.loadDraft(a);
      second.loadDraft(b);
    });
    const current = refs('A');
    let target!: Awaited<ReturnType<typeof prepareDraftSwitch>>;
    await act(async () => {
      target = await prepareDraftSwitch(
        'b',
        () => current,
        first.getDraftSession,
        first.saveNow,
        one.readDraft,
        () => true,
      );
    });
    expect(target.status).toBe('ready');
    if (target.status !== 'ready') throw new Error('target not ready');
    const selectedDraft = target.draft;
    if (change === 'edit')
      await act(async () => {
        await second.autoSave(refs('new B'));
      });
    else
      await act(async () => {
        await second.discard();
      });
    act(() => first.loadDraft(selectedDraft));
    await act(async () => {
      await first.autoSave(refs('old B'));
    });
    expect(first.draftConflict).toBe(true);
    expect(mockData.get(key)?.find((d) => d.id === 'b')?.postContent).toBe(
      change === 'edit' ? 'new B' : undefined,
    );
    act(() => renderer.unmount());
  },
);

it('retains unsaved work when saving a conflict copy fails and succeeds on retry', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('new A'));
    await second.autoSave(refs('unsaved text'));
  });
  expect(second.draftConflict).toBe(true);
  mockFailNextWrite = true;
  await act(async () => {
    await expect(second.saveAsCopy(refs('unsaved text'))).rejects.toThrow();
  });
  expect(second.autoSaveError).toBe(true);
  expect(second.currentDraftId).toBeNull();
  await act(async () => {
    await second.autoSave(refs('unsaved text'));
  });
  expect(second.autoSaveError).toBe(false);
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  expect(mockData.get(key)?.find((d) => d.id === second.currentDraftId)?.postContent).toBe(
    'unsaved text',
  );
  act(() => renderer.unmount());
});

it('keeps later edits made while a conflict copy is being saved', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('new A'));
    await second.autoSave(refs('old edit'));
  });
  expect(second.draftConflict).toBe(true);
  mockBlockNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let copy!: Promise<void>, later!: Promise<void>;
  await act(async () => {
    copy = second.saveAsCopy(refs('old edit'));
    await started;
  });
  act(() => {
    later = second.autoSave(refs('later edit'));
  });
  await act(async () => {
    mockReleaseWrite();
    await Promise.all([copy, later]);
  });
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  expect(mockData.get(key)?.find((d) => d.id === second.currentDraftId)?.postContent).toBe(
    'later edit',
  );
  act(() => renderer.unmount());
});

it('surfaces a revision conflict if publishing fails after a pending autosave conflicts', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  mockBlockNextWrite = true;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  mockWriteStarted = start;
  let update!: Promise<void>, pending!: Promise<void>;
  await act(async () => {
    update = first.autoSave(refs('new A'));
    await started;
  });
  act(() => {
    pending = second.autoSave(refs('my draft'));
    second.beginPublish();
  });
  await act(async () => {
    mockReleaseWrite();
    await Promise.all([update, pending]);
    await second.publishFailed(refs('my draft'));
  });
  expect(second.draftConflict).toBe(true);
  expect(second.autoSaveError).toBe(true);
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.postContent).toBe('new A');
  act(() => renderer.unmount());
});
it('preserves a newer conflict copy saved while publication is in flight', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  const a = draft('a', 'original A');
  mockData.set(key, [a]);
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('other writer'));
    await second.autoSave(refs('my conflicted text'));
  });
  expect(second.draftConflict).toBe(true);
  act(() => second.beginPublish());
  await act(async () => {
    await second.saveAsCopy(refs('new text typed during publish'));
  });
  const copyId = second.currentDraftId;
  expect(mockData.get(key)?.find((d) => d.id === copyId)?.postContent).toBe(
    'new text typed during publish',
  );
  await act(async () => {
    await second.publishSucceeded();
    second.endPublish();
  });
  expect(mockData.get(key)?.find((d) => d.id === copyId)?.postContent).toBe(
    'new text typed during publish',
  );
  act(() => renderer.unmount());
});
it('does not delete selected draft B when A publication succeeds during a switch', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  const a = draft('a', 'published A'),
    b = draft('b', 'private B');
  mockData.set(key, [a, b]);
  let one!: ReturnType<typeof useDrafts>, manager!: ReturnType<typeof useDraftManager>;
  function Single() {
    one = useDrafts();
    manager = useDraftManager({
      saveDraft: one.saveDraft,
      queueDeleteDraft: one.queueDeleteDraft,
      onDraftLoad: () => {},
    });
    latest = manager;
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Single />);
  });
  act(() => {
    manager.loadDraft(a);
    manager.beginPublish();
  });
  const snapshot = refs('published A');
  let selected!: Awaited<ReturnType<typeof prepareDraftSwitch>>;
  await act(async () => {
    selected = await prepareDraftSwitch(
      'b',
      () => snapshot,
      manager.getDraftSession,
      manager.saveNow,
      one.readDraft,
      () => true,
    );
  });
  expect(selected.status).toBe('ready');
  if (selected.status !== 'ready') throw new Error('target not ready');
  const selectedDraft = selected.draft;
  act(() => manager.loadDraft(selectedDraft));
  await act(async () => {
    await manager.publishSucceeded();
    manager.endPublish();
  });
  expect(mockData.get(key)?.find((d) => d.id === 'b')?.postContent).toBe('private B');
  expect(manager.currentDraftId).toBe('b');
  act(() => renderer.unmount());
});
it('does not report conflict for two unchanged editors of the same normalized draft', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  let seed!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    seed = TestRenderer.create(<Probe />);
  });
  await act(async () => {
    await latest.autoSave(refs('unchanged text'));
  });
  const a = firstStoredDraft();
  act(() => seed.unmount());
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('unchanged text'));
  });
  const writesAfterFirst = mockEvents.length;
  const revisionAfterFirst = mockData.get(key)?.[0].localRevision;
  await act(async () => {
    await second.autoSave(refs('unchanged text'));
  });
  expect(second.draftConflict).toBe(false);
  expect(mockEvents).toHaveLength(writesAfterFirst);
  expect(mockData.get(key)?.[0].localRevision).toBe(revisionAfterFirst);
  act(() => renderer.unmount());
});

it('still reports conflict for a real thread change when the root text is unchanged', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  let seed!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    seed = TestRenderer.create(<Probe />);
  });
  await act(async () => {
    await latest.autoSave(refs('same root'));
  });
  const original = firstStoredDraft();
  act(() => seed.unmount());
  let first!: ReturnType<typeof useDraftManager>, second!: ReturnType<typeof useDraftManager>;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(original);
    second.loadDraft(original);
  });
  const thread = {
    id: 't',
    text: 'important reply',
    mediaIds: [],
    pollOptions: [],
    pollTitle: '',
    showPollCreator: false,
    location: null,
    mentions: [],
    sources: [],
    article: null,
    event: null,
    room: null,
    podcast: null,
    commerce: [],
    attachmentOrder: [],
    laneId: null,
    replyPermission: ['anyone'],
    reviewReplies: false,
    quotesDisabled: false,
    isSensitive: false,
    publishAs: null,
  };
  await act(async () => {
    await first.autoSave({ ...refs('same root'), threadItems: [thread] } as ComposeDraftRefs);
  });
  await act(async () => {
    await second.autoSave(refs('same root'));
  });
  expect(second.draftConflict).toBe(true);
  expect(mockData.get(key)?.[0].threadItems[0].text).toBe('important reply');
  act(() => renderer.unmount());
});

it('accepts identical stored JSON with reordered object keys without writing again', async () => {
  mockViewer = 'viewer-a';
  mockData.clear();
  mockEvents.length = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  await act(async () => {
    await latest.autoSave(refs('same text'));
  });
  const original = firstStoredDraft();
  function reorder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reorder);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([k, v]) => [k, reorder(v)]),
      );
    return value;
  }
  const concurrent = reorder({
    ...original,
    localRevision: (original.localRevision ?? 0) + 1,
  }) as Draft;
  mockData.set(key, [concurrent]);
  const writes = mockEvents.length;
  await act(async () => {
    await latest.autoSave(refs('same text'));
  });
  expect(latest.draftConflict).toBe(false);
  expect(mockEvents).toHaveLength(writes);
  expect(mockData.get(key)?.[0].localRevision).toBe(concurrent.localRevision);
  act(() => renderer.unmount());
});

it('deletes the current draft when its editor is emptied', async () => {
  const a = draft('a', 'stored A');
  mockData.set(key, [a]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  act(() => latest.loadDraft(a));
  await act(async () => {
    await latest.autoSave(refs(''));
  });
  expect(mockData.get(key)).toEqual([]);
  expect(latest.currentDraftId).toBeNull();
  act(() => renderer.unmount());
});

it('keeps a concurrent edit when an old editor is emptied', async () => {
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let first!: DraftManager, second!: DraftManager;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('new A'));
    await second.autoSave(refs(''));
  });
  expect(second.draftConflict).toBe(true);
  expect(mockData.get(key)?.[0].postContent).toBe('new A');
  act(() => renderer.unmount());
});

it('keeps a conflict visible on manual save and does not silently retry background saves', async () => {
  const a = draft('a', 'old A');
  mockData.set(key, [a]);
  let first!: DraftManager, second!: DraftManager;
  const Pair = createPairProbe((a, b) => {
    first = a;
    second = b;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Pair />);
  });
  act(() => {
    first.loadDraft(a);
    second.loadDraft(a);
  });
  await act(async () => {
    await first.autoSave(refs('new A'));
    await second.autoSave(refs('my work'));
  });
  const writes = mockEvents.length;
  await act(async () => {
    await second.autoSave(refs('my changed work'));
    await expect(second.saveNow(refs('my changed work'))).rejects.toMatchObject({
      name: 'DraftConflictError',
    });
  });
  expect(second.draftConflict).toBe(true);
  expect(second.autoSaveError).toBe(true);
  expect(mockEvents).toHaveLength(writes);
  act(() => renderer.unmount());
});

it('preserves an invalid revision and permits saving editor contents as a copy', async () => {
  const a = { ...draft('a', 'old A'), localRevision: 'broken' };
  mockData.set(key, [a as unknown as Draft]);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  act(() => latest.loadDraft(a));
  expect(latest.draftConflict).toBe(true);
  expect(latest.autoSaveError).toBe(true);
  await act(async () => {
    await latest.saveAsCopy(refs('my work'));
  });
  expect(mockData.get(key)?.find((d) => d.id === 'a')?.localRevision).toBe('broken');
  expect(mockData.get(key)?.find((d) => d.id === latest.currentDraftId)?.postContent).toBe(
    'my work',
  );
  act(() => renderer.unmount());
});

it('stores mention metadata that is still present in the text', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  await act(async () => {
    await latest.autoSave({
      ...refs('Hello [mention:alice-id]'),
      mentions: [{ userId: 'alice-id', username: 'alice', displayName: 'Alice' }],
    });
  });
  expect(mockData.get(key)?.[0].mentions).toEqual([
    { userId: 'alice-id', handle: 'alice', name: 'Alice' },
  ]);
  act(() => renderer.unmount());
});
