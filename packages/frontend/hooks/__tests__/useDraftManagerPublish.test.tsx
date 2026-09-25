import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useDraftManager, type ComposeDraftRefs } from '../useDraftManager';
import { createVariantsState } from '@/utils/composeVariants';

/**
 * A published post must not survive as a draft; a failed one must.
 *
 * OxyHQ/Mention#1140: after publishing "QA composer check", the next compose
 * opened on "QA composer check" again. Two ways the draft outlived its post are
 * pinned here, both ORDERING bugs a render cannot show:
 *
 * - the 2-second autosave debounce, armed by the last keystroke, fired AFTER the
 *   publish had deleted the draft and saved the published text straight back;
 * - an autosave that fired DURING the request created the draft, and the publish
 *   deleted the id its render had captured — none — so it was never removed.
 */

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { error: jest.fn() },
}));

type DraftManager = ReturnType<typeof useDraftManager>;
let latest: DraftManager | null = null;

const saveDraft = jest.fn(async (_draft: unknown) => 'draft-1');
const deleteDraft = jest.fn(async (_id: string) => undefined);
const onDraftLoad = jest.fn();

function Probe() {
  latest = useDraftManager({ saveDraft, deleteDraft, onDraftLoad });
  return null;
}

const manager = (): DraftManager => {
  if (!latest) throw new Error('the probe never rendered');
  return latest;
};

const refs = (postContent: string): ComposeDraftRefs => ({
  postContent,
  mediaIds: [],
  pollOptions: [],
  pollTitle: '',
  showPollCreator: false,
  location: null,
  sources: [],
  article: null,
  podcast: null,
  job: null,
  threadItems: [],
  mentions: [],
  postingMode: 'thread',
  attachmentOrder: [],
  scheduledAt: null,
  currentDraftId: manager().currentDraftId,
  variants: createVariantsState('en'),
});

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  saveDraft.mockImplementation(async () => 'draft-1');
  deleteDraft.mockImplementation(async () => undefined);
  latest = null;
  act(() => {
    TestRenderer.create(<Probe />);
  });
});

describe('useDraftManager across a publish', () => {
  it('deletes the draft a successful publish came from', async () => {
    await act(async () => {
      await manager().autoSave(refs('QA composer check'));
    });
    expect(manager().currentDraftId).toBe('draft-1');

    await act(async () => {
      manager().beginPublish();
      await manager().publishSucceeded();
    });

    expect(deleteDraft).toHaveBeenCalledWith('draft-1');
    expect(manager().currentDraftId).toBeNull();
  });

  it('cancels the pending autosave debounce when a publish starts', () => {
    jest.useFakeTimers();
    try {
      const fired = jest.fn();
      manager().autoSaveTimeoutRef.current = setTimeout(fired, 2000) as unknown as ReturnType<typeof setTimeout>;

      manager().beginPublish();
      jest.advanceTimersByTime(5000);

      expect(fired).not.toHaveBeenCalled();
      expect(manager().autoSaveTimeoutRef.current).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not save the published text while the publish is settling', async () => {
    await act(async () => {
      manager().beginPublish();
      await manager().autoSave(refs('QA composer check'));
      await manager().publishSucceeded();
      // The composer still holds the text until it resets itself; an autosave
      // in that window must stay a no-op.
      await manager().autoSave(refs('QA composer check'));
    });

    expect(saveDraft).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it('deletes a draft that an autosave created while the request was in flight', async () => {
    let finishSave: (id: string) => void = () => {};
    saveDraft.mockImplementation(
      () => new Promise<string>((resolve) => { finishSave = resolve; }),
    );

    let inFlight: Promise<void> = Promise.resolve();
    act(() => {
      inFlight = manager().autoSave(refs('QA composer check'));
    });
    // The publish starts with the save still pending: no draft id exists yet.
    manager().beginPublish();
    expect(manager().currentDraftId).toBeNull();

    let settled: Promise<void> = Promise.resolve();
    act(() => {
      settled = manager().publishSucceeded();
    });
    await act(async () => {
      finishSave('draft-late');
      await inFlight;
      await settled;
    });

    expect(deleteDraft).toHaveBeenCalledWith('draft-late');
    expect(manager().currentDraftId).toBeNull();
  });

  it('keeps and saves the draft when the publish fails', async () => {
    await act(async () => {
      manager().beginPublish();
      await manager().publishFailed(refs('QA composer check'));
    });

    expect(deleteDraft).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0][0]).toMatchObject({ postContent: 'QA composer check' });
    expect(manager().currentDraftId).toBe('draft-1');

    // Autosave is back on for the author's next edit.
    await act(async () => {
      await manager().autoSave(refs('QA composer check, edited'));
    });
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft.mock.calls[1][0]).toMatchObject({ id: 'draft-1' });
  });

  it('resumes autosave once the composer has been emptied', async () => {
    await act(async () => {
      manager().beginPublish();
      await manager().publishSucceeded();
      manager().endPublish();
      await manager().autoSave(refs('the next post'));
    });

    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0][0]).toMatchObject({ postContent: 'the next post' });
    expect(saveDraft.mock.calls[0][0]).not.toHaveProperty('id', 'draft-1');
  });

  it('does not fail a published post when deleting its draft fails', async () => {
    deleteDraft.mockImplementation(async () => {
      throw new Error('storage unavailable');
    });
    await act(async () => {
      await manager().autoSave(refs('QA composer check'));
    });

    await act(async () => {
      manager().beginPublish();
      await expect(manager().publishSucceeded()).resolves.toBeUndefined();
    });
    expect(manager().currentDraftId).toBeNull();
  });
});

