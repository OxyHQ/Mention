import {
  engagementQueueStorageKey,
  parseEngagementQueue,
  serializeEngagementQueue,
} from '../engagementQueuePersistence';

interface TestUpdate {
  type: 'like';
  timestamp: number;
}

describe('viewer-owned engagement queue persistence', () => {
  const updates: Record<string, TestUpdate[]> = {
    'post-1': [{ type: 'like', timestamp: 123 }],
  };

  it('uses a distinct encoded storage namespace for every viewer', () => {
    expect(engagementQueueStorageKey('viewer/a')).toBe(
      'mention-engagement-queue:v2:viewer%2Fa',
    );
    expect(engagementQueueStorageKey('viewer/a')).not.toBe(
      engagementQueueStorageKey('viewer-b'),
    );
  });

  it('round-trips only when the envelope owner matches the active viewer', () => {
    const raw = serializeEngagementQueue('viewer-a', updates);

    expect(parseEngagementQueue<TestUpdate>(raw, 'viewer-a')).toEqual(updates);
    expect(parseEngagementQueue<TestUpdate>(raw, 'viewer-b')).toBeNull();
  });

  it('rejects the legacy ownerless payload instead of guessing an identity', () => {
    expect(
      parseEngagementQueue<TestUpdate>(JSON.stringify(updates), 'viewer-a'),
    ).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(parseEngagementQueue<TestUpdate>('not-json', 'viewer-a')).toBeNull();
    expect(
      parseEngagementQueue<TestUpdate>(
        JSON.stringify({ version: 2, viewerId: 'viewer-a', updates: [] }),
        'viewer-a',
      ),
    ).toBeNull();
  });
});
