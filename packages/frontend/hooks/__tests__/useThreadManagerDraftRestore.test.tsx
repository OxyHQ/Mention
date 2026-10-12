import TestRenderer, { act } from 'react-test-renderer';
import { useThreadManager, type ThreadItem } from '../useThreadManager';

/**
 * A thread item restored from a draft must arrive COMPLETE.
 *
 * A draft persists a box's authored content — text, media, mentions and every
 * attachment — but not its per-item interaction settings, lane or account.
 * `loadThreadsFromDraft` used to declare `ThreadItem[]` while being
 * handed that narrower persisted shape and pass it straight to `setThreadItems`,
 * so a restored item reached the composer with `replyPermission`, `isSensitive`,
 * `quotesDisabled` and `reviewReplies` simply ABSENT.
 *
 * That silently discarded the author's own choices: a thread drafted with
 * replies restricted, or flagged sensitive, came back unrestricted and unflagged
 * and would have posted that way. These assertions pin the consent-bearing
 * fields specifically, because that is the part whose loss is invisible.
 */

type ThreadManager = ReturnType<typeof useThreadManager>;
let latest: ThreadManager | null = null;

function Probe() {
  latest = useThreadManager();
  return null;
}

/** Exactly what a stored draft carries for one thread item — nothing more. */
const persistedThreadItem = {
  id: 'thread-1',
  text: 'restored body',
  mediaIds: [{ id: 'file-1', type: 'image' as const }],
  pollOptions: ['a', 'b'],
  pollTitle: 'poll?',
  showPollCreator: true,
  location: { latitude: 1, longitude: 2, address: 'somewhere' },
  mentions: [],
  sources: [{ id: 'source-1', title: 'Source', url: 'https://example.com' }],
  article: { title: 'Article', body: 'Body' },
  event: { name: 'Launch', date: '2026-10-01T18:00:00.000Z', location: 'Barcelona' },
  room: { roomId: 'room-1', title: 'Room', status: 'scheduled' as const },
  podcast: { syraPodcastId: 'podcast-1', title: 'Show' },
  attachmentOrder: ['event', 'media:file-1'],
};

describe('useThreadManager draft restore', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    latest = null;
    act(() => {
      TestRenderer.create(<Probe />);
    });
  });

  it('gives a draft-restored item the same interaction defaults as a fresh one', () => {
    act(() => {
      latest!.addThread();
    });
    const fresh = latest!.threadItems[0];

    act(() => {
      latest!.loadThreadsFromDraft([persistedThreadItem]);
    });
    const restored = latest!.threadItems[0];

    // The consent-bearing fields a draft never persisted. Absent before the fix.
    expect(restored.replyPermission).toEqual(fresh.replyPermission);
    expect(restored.isSensitive).toBe(fresh.isSensitive);
    expect(restored.quotesDisabled).toBe(fresh.quotesDisabled);
    expect(restored.reviewReplies).toBe(fresh.reviewReplies);
  });

  it('leaves no field of a restored item undefined', () => {
    act(() => {
      latest!.loadThreadsFromDraft([persistedThreadItem]);
    });
    const restored = latest!.threadItems[0];

    // A vacuity floor: catches a future field added to `ThreadItem` that the
    // restore path forgets, which is exactly how this bug arose.
    const keys: (keyof ThreadItem)[] = [
      'id',
      'text',
      'mediaIds',
      'pollOptions',
      'pollTitle',
      'showPollCreator',
      'location',
      'mentions',
      'sources',
      'article',
      'event',
      'room',
      'attachmentOrder',
      'replyPermission',
      'reviewReplies',
      'quotesDisabled',
      'isSensitive',
    ];
    for (const key of keys) {
      expect(restored[key]).toBeDefined();
    }
  });

  it('preserves what the draft DID persist', () => {
    act(() => {
      latest!.loadThreadsFromDraft([persistedThreadItem]);
    });
    const restored = latest!.threadItems[0];

    expect(restored.id).toBe('thread-1');
    expect(restored.text).toBe('restored body');
    expect(restored.mediaIds).toEqual([{ id: 'file-1', type: 'image' }]);
    expect(restored.pollOptions).toEqual(['a', 'b']);
    expect(restored.pollTitle).toBe('poll?');
    expect(restored.showPollCreator).toBe(true);
    expect(restored.location).toEqual({ latitude: 1, longitude: 2, address: 'somewhere' });
    expect(restored.sources).toEqual(persistedThreadItem.sources);
    expect(restored.article).toEqual(persistedThreadItem.article);
    expect(restored.event).toEqual(persistedThreadItem.event);
    expect(restored.room).toEqual(persistedThreadItem.room);
    expect(restored.podcast).toEqual(persistedThreadItem.podcast);
    expect(restored.attachmentOrder).toEqual(['event', 'media:file-1']);
  });
});
