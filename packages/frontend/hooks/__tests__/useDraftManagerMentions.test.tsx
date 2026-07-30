import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useDraftManager } from '../useDraftManager';

jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  logger: {
    error: jest.fn(),
  },
}));

type DraftManager = ReturnType<typeof useDraftManager>;
let latest: DraftManager | null = null;

const saveDraft = jest.fn(async () => 'draft-id');
const deleteDraft = jest.fn(async () => undefined);
const onDraftLoad = jest.fn();

function Probe() {
  latest = useDraftManager({ saveDraft, deleteDraft, onDraftLoad });
  return null;
}

describe('useDraftManager mention restoration', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    latest = null;
    act(() => {
      TestRenderer.create(<Probe />);
    });
  });

  it('restores only metadata backed by main or variant placeholders', () => {
    act(() => {
      latest!.loadDraft({
        id: 'draft-1',
        postContent: 'Primary text without Alice',
        mentions: [
          { userId: 'alice-id', handle: 'alice', name: 'Alice' },
          { userId: 'bob-id', handle: 'bob', name: 'Bob' },
        ],
        mediaIds: [],
        pollOptions: [],
        threadItems: [
          {
            id: 'thread-1',
            text: 'Thread primary',
            mediaIds: [],
            mentions: [
              { userId: 'orphan-id', handle: 'orphan', name: 'Orphan' },
              { userId: 'carol-id', handle: 'carol', name: 'Carol' },
            ],
          },
        ],
        languages: {
          primaryTag: 'es',
          primaryChosen: true,
          languages: [
            {
              tag: 'en',
              items: [
                { itemId: 'main', text: 'Hello [mention:bob-id]' },
                { itemId: 'thread-1', text: 'Then [mention:carol-id]' },
              ],
            },
          ],
        },
      });
    });

    const restored = onDraftLoad.mock.calls[0][0];
    expect(restored.mentions).toEqual([
      { userId: 'bob-id', username: 'bob', displayName: 'Bob' },
    ]);
    expect(restored.threadItems[0].mentions).toEqual([
      { userId: 'carol-id', username: 'carol', displayName: 'Carol' },
    ]);
  });

  it('does not infer metadata from a placeholder missing the draft allowlist', () => {
    act(() => {
      latest!.loadDraft({
        id: 'draft-2',
        postContent: 'Hello [mention:victim-id]',
        mentions: [],
        mediaIds: [],
        pollOptions: [],
        threadItems: [],
      });
    });

    expect(onDraftLoad.mock.calls[0][0].mentions).toEqual([]);
  });
});
