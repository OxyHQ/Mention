import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useDraftManager, type ComposeDraftRefs } from '../useDraftManager';
import type { DraftInput } from '../useDrafts';
import type { ThreadItem } from '../useThreadManager';
import { createVariantsState } from '@/utils/composeVariants';

/**
 * One editing session keeps ONE draft, holding everything the author made.
 *
 * OxyHQ/Mention#1124, reproduced in production:
 *  - a saved draft came back without its event: the draft never stored one;
 *  - "Save draft" after an autosave left two copies: the manual save carried no
 *    draft id, so it created a second draft beside the autosaved one;
 *  - "Discard" left the autosaved draft behind: it only closed the composer.
 */

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { error: jest.fn() },
}));

type DraftManager = ReturnType<typeof useDraftManager>;
let latest: DraftManager | null = null;

/** A stand-in for storage: the drafts by id, as `useDrafts` would keep them. */
let stored: Map<string, DraftInput>;
let nextId: number;
const saveDraft = jest.fn(async (draft: DraftInput) => {
  const id = draft.id ?? `draft-${nextId++}`;
  stored.set(id, { ...draft, id });
  return id;
});
const deleteDraft = jest.fn(async (id: string) => {
  stored.delete(id);
});
const onDraftLoad = jest.fn();

function Probe() {
  latest = useDraftManager({ saveDraft, deleteDraft, onDraftLoad });
  return null;
}

const manager = (): DraftManager => {
  if (!latest) throw new Error('the probe never rendered');
  return latest;
};

const EVENT = {
  name: 'QA launch',
  date: '2026-10-01T18:00:00.000Z',
  location: 'Barcelona',
  description: 'Doors at six',
};

const refs = (overrides: Partial<ComposeDraftRefs> = {}): ComposeDraftRefs => ({
  postContent: '',
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
  currentDraftId: manager().currentDraftId,
  variants: createVariantsState('en'),
  ...overrides,
});

const threadItem = (overrides: Partial<ThreadItem> = {}): ThreadItem => ({
  id: 'thread-1',
  text: '',
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
  laneId: null,
  attachmentOrder: [],
  replyPermission: ['anyone'],
  reviewReplies: false,
  quotesDisabled: false,
  isSensitive: false,
  publishAs: null,
  ...overrides,
});

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  stored = new Map();
  nextId = 1;
  latest = null;
  act(() => {
    TestRenderer.create(<Probe />);
  });
});

describe('a draft keeps what the author attached', () => {
  it('stores and restores an event-only draft, with its place in the order', async () => {
    await act(async () => {
      await manager().autoSave(refs({ event: EVENT, attachmentOrder: ['event'] }));
    });

    expect(stored.size).toBe(1);
    const [draft] = [...stored.values()];
    expect(draft.event).toEqual(EVENT);

    act(() => {
      manager().loadDraft(draft);
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.event).toEqual(EVENT);
    expect(restored.attachmentOrder).toEqual(['event']);
  });

  it('keeps the event beside text and media in the order the author set', async () => {
    const media = [{ id: 'file-1', type: 'image' as const }];
    await act(async () => {
      await manager().saveNow(refs({
        postContent: 'with an event',
        event: EVENT,
        mediaIds: media,
        attachmentOrder: ['media:file-1', 'event'],
      }));
    });

    act(() => {
      manager().loadDraft([...stored.values()][0]);
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.postContent).toBe('with an event');
    expect(restored.event).toEqual(EVENT);
    expect(restored.attachmentOrder).toEqual(['media:file-1', 'event']);
  });

  it('round-trips a room and every attachment of a thread box', async () => {
    const room = { roomId: 'room-1', title: 'Live Q&A', status: 'scheduled' as const, type: 'stage' as const };
    const box = threadItem({
      text: 'second post',
      sources: [{ id: 's1', title: 'Source', url: 'https://example.com' }],
      article: { title: 'Long read', body: 'Body' },
      event: EVENT,
      room,
      podcast: { syraPodcastId: 'pod-1', title: 'Show' },
      attachmentOrder: ['room', 'event', 'article', 'podcast', 'sources'],
    });
    await act(async () => {
      await manager().autoSave(refs({ postContent: 'first', room, threadItems: [box] }));
    });

    act(() => {
      manager().loadDraft([...stored.values()][0]);
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.room).toEqual(room);
    expect(restored.threadItems[0]).toMatchObject({
      text: 'second post',
      sources: box.sources,
      article: box.article,
      event: EVENT,
      room,
      podcast: box.podcast,
      attachmentOrder: ['room', 'event', 'article', 'podcast', 'sources'],
    });
  });

  it('drops an incomplete stored event instead of restoring a broken one', () => {
    act(() => {
      manager().loadDraft({
        id: 'draft-old',
        postContent: 'text',
        event: { name: '   ', date: '2026-10-01T18:00:00.000Z' },
        attachmentOrder: ['event'],
      });
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.event).toBeNull();
    expect(restored.attachmentOrder).toEqual([]);
  });

  it('opens a draft saved before events were kept', () => {
    act(() => {
      manager().loadDraft({ id: 'draft-legacy', postContent: 'old', threadItems: [{ id: 't', text: 'x' }] });
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.event).toBeNull();
    expect(restored.room).toBeNull();
    expect(restored.threadItems[0]).toMatchObject({ sources: [], article: null, event: null, room: null, podcast: null, attachmentOrder: [] });
  });
});

describe('"Save draft" updates the session draft', () => {
  it('writes into the draft the autosave created, not a second one', async () => {
    await act(async () => {
      await manager().autoSave(refs({ postContent: 'unique text' }));
    });
    await act(async () => {
      await manager().saveNow(refs({ postContent: 'unique text, edited' }));
    });

    expect(stored.size).toBe(1);
    expect(stored.get('draft-1')?.postContent).toBe('unique text, edited');
    expect(saveDraft.mock.calls[1][0].id).toBe('draft-1');
  });

  it('waits for an autosave still in flight and then updates the draft it creates', async () => {
    let releaseFirst!: () => void;
    saveDraft.mockImplementationOnce(async (draft: DraftInput) => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      const id = draft.id ?? `draft-${nextId++}`;
      stored.set(id, { ...draft, id });
      return id;
    });

    let autosave!: Promise<void>;
    let manual!: Promise<void>;
    act(() => {
      autosave = manager().autoSave(refs({ postContent: 'typed' }));
      manual = manager().saveNow(refs({ postContent: 'typed more' }));
    });
    await act(async () => {
      releaseFirst();
      await Promise.all([autosave, manual]);
    });

    expect(stored.size).toBe(1);
    expect(stored.get('draft-1')?.postContent).toBe('typed more');
  });

  it('cancels the pending debounce so it cannot write after the save', async () => {
    manager().autoSaveTimeoutRef.current = setTimeout(jest.fn(), 60_000) as unknown as ReturnType<typeof setTimeout>;
    await act(async () => {
      await manager().saveNow(refs({ postContent: 'saved' }));
    });
    expect(manager().autoSaveTimeoutRef.current).toBeNull();
  });

  it('throws when the write fails, so the composer can say so', async () => {
    saveDraft.mockRejectedValueOnce(new Error('storage full'));
    await expect(manager().saveNow(refs({ postContent: 'x' }))).rejects.toThrow('storage full');
  });
});

describe('"Discard" removes the session draft', () => {
  it('deletes the draft a settled autosave stored', async () => {
    stored.set('other', {
      id: 'other',
      postContent: 'unrelated',
      mediaIds: [],
      pollOptions: [],
      showPollCreator: false,
      location: null,
      threadItems: [],
      mentions: [],
      postingMode: 'thread',
    });
    await act(async () => {
      await manager().autoSave(refs({ postContent: 'throw me away' }));
    });
    await act(async () => {
      await manager().discard();
    });

    expect([...stored.keys()]).toEqual(['other']);
    expect(manager().currentDraftId).toBeNull();
  });

  it('lets an autosave in flight at the debounce boundary land, then deletes it', async () => {
    let releaseSave!: () => void;
    saveDraft.mockImplementationOnce(async (draft: DraftInput) => {
      await new Promise<void>((resolve) => { releaseSave = resolve; });
      const id = draft.id ?? `draft-${nextId++}`;
      stored.set(id, { ...draft, id });
      return id;
    });

    let autosave!: Promise<void>;
    let discard!: Promise<void>;
    act(() => {
      autosave = manager().autoSave(refs({ postContent: 'closing now' }));
      discard = manager().discard();
    });
    await act(async () => {
      releaseSave();
      await Promise.all([autosave, discard]);
    });

    expect(stored.size).toBe(0);
  });

  it('cancels the pending debounce and never autosaves again', async () => {
    manager().autoSaveTimeoutRef.current = setTimeout(jest.fn(), 60_000) as unknown as ReturnType<typeof setTimeout>;
    await act(async () => {
      await manager().discard();
    });
    expect(manager().autoSaveTimeoutRef.current).toBeNull();

    await act(async () => {
      await manager().autoSave(refs({ postContent: 'late keystroke' }));
    });
    expect(saveDraft).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });
});

describe('a draft round-trips every field it keeps', () => {
  it('keeps the root job, a full podcast, the schedule and the posting mode', async () => {
    const job = {
      mentionJobId: 'job-1',
      title: 'Engineer',
      employerName: 'Oxy',
      employerOxyUserId: 'oxy-1',
      canonicalUrl: 'https://mention.earth/jobs/job-1',
      status: 'published' as const,
      location: { countryCode: 'ES', city: 'Barcelona' },
    };
    const podcast = { syraPodcastId: 'pod-1', title: 'Show', author: 'Host', artworkUrl: 'https://x.test/a.png' };
    const scheduledAt = new Date('2026-12-01T10:00:00.000Z');
    await act(async () => {
      await manager().saveNow(refs({
        postContent: 'hiring',
        job: job as ComposeDraftRefs['job'],
        podcast,
        scheduledAt,
        postingMode: 'beast',
        pollOptions: ['yes', ''],
        pollTitle: 'Apply?',
      }));
    });

    act(() => {
      manager().loadDraft([...stored.values()][0]);
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.job).toMatchObject({ mentionJobId: 'job-1', location: { countryCode: 'ES', city: 'Barcelona' } });
    expect(restored.podcast).toEqual(podcast);
    expect(restored.scheduledAt).toEqual(scheduledAt);
    expect(restored.postingMode).toBe('beast');
    expect(restored.showPollCreator).toBe(true);
    expect(restored.pollTitle).toBe('Apply?');
    expect(restored.attachmentOrder).toEqual(expect.arrayContaining(['poll', 'podcast', 'job']));
  });

  it('narrows what storage holds instead of trusting it', () => {
    act(() => {
      manager().loadDraft({
        id: 'draft-odd',
        postContent: 'old shapes',
        // Bare file ids, as drafts once stored media.
        mediaIds: ['file-1'],
        scheduledAt: 'not a date',
        job: { mentionJobId: 'job-1' },
        podcast: { title: 'no id' },
        room: { roomId: 'r', title: 'Room', status: 'paused', type: 'party' },
        location: { latitude: 'north', longitude: 2 },
      });
    });
    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.mediaIds).toEqual([expect.objectContaining({ id: 'file-1' })]);
    expect(restored.scheduledAt).toBeNull();
    expect(restored.job).toBeNull();
    expect(restored.podcast).toBeNull();
    expect(restored.room).toEqual({ roomId: 'r', title: 'Room', status: undefined, type: undefined, topic: undefined, host: undefined });
    expect(restored.location).toEqual({ latitude: 0, longitude: 2, address: undefined });
  });
});
