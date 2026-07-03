import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest: mocks.makeServiceRequest }),
}));

import { OxySignalsClient } from '../../services/OxySignalsClient';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.makeServiceRequest.mockResolvedValue({});
});

describe('OxySignalsClient.pushEndorsements', () => {
  it('posts endorsements to /app-signals/ingest (no clientId — app derived from token)', async () => {
    const client = new OxySignalsClient();
    const edges = [{ ownerId: 'o', memberId: 'm', op: 'add' as const, sourceId: 's' }];
    await client.pushEndorsements(edges);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    const [method, url, body] = mocks.makeServiceRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe('/app-signals/ingest');
    expect(body).toEqual({ endorsements: edges });
  });

  it('no-ops without a network call when given no edges', async () => {
    const client = new OxySignalsClient();
    await client.pushEndorsements([]);
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('chunks large batches at 500 edges per request', async () => {
    const client = new OxySignalsClient();
    const edges = Array.from({ length: 1100 }, (_, i) => ({
      ownerId: 'o', memberId: `m${i}`, op: 'add' as const, sourceId: 's',
    }));
    await client.pushEndorsements(edges);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(3); // 500 + 500 + 100
    expect(mocks.makeServiceRequest.mock.calls[0][2].endorsements).toHaveLength(500);
    expect(mocks.makeServiceRequest.mock.calls[2][2].endorsements).toHaveLength(100);
  });

  it('propagates transport errors so callers can retry', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('boom'));
    const client = new OxySignalsClient();
    await expect(
      client.pushEndorsements([{ ownerId: 'o', memberId: 'm', op: 'add', sourceId: 's' }]),
    ).rejects.toThrow('boom');
  });
});

describe('OxySignalsClient.pushInterests', () => {
  it('posts interests to /app-signals/ingest', async () => {
    const client = new OxySignalsClient();
    const interests = [{ userId: 'u', interestScore: 0.5 }];
    await client.pushInterests(interests);

    const [, url, body] = mocks.makeServiceRequest.mock.calls[0];
    expect(url).toBe('/app-signals/ingest');
    expect(body).toEqual({ interests });
  });

  it('no-ops without a network call when given no items', async () => {
    const client = new OxySignalsClient();
    await client.pushInterests([]);
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });
});

describe('OxySignalsClient.pushEvents', () => {
  it('posts affinity events to /app-signals/events (no clientId — app derived from token)', async () => {
    const client = new OxySignalsClient();
    const events = [{ fromUserId: 'a', toUserId: 'b', type: 'like' as const, eventId: 'like:1' }];
    await client.pushEvents(events);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    const [method, url, body] = mocks.makeServiceRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe('/app-signals/events');
    expect(body).toEqual({ events });
  });

  it('no-ops without a network call when given no events', async () => {
    const client = new OxySignalsClient();
    await client.pushEvents([]);
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('chunks large batches at 1000 events per request', async () => {
    const client = new OxySignalsClient();
    const events = Array.from({ length: 2300 }, (_, i) => ({
      fromUserId: 'a', toUserId: `b${i}`, type: 'like' as const,
    }));
    await client.pushEvents(events);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(3); // 1000 + 1000 + 300
    expect(mocks.makeServiceRequest.mock.calls[0][2].events).toHaveLength(1000);
    expect(mocks.makeServiceRequest.mock.calls[2][2].events).toHaveLength(300);
  });

  it('propagates transport errors so the drain job can re-buffer or drop', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('boom'));
    const client = new OxySignalsClient();
    await expect(
      client.pushEvents([{ fromUserId: 'a', toUserId: 'b', type: 'like' }]),
    ).rejects.toThrow('boom');
  });
});
