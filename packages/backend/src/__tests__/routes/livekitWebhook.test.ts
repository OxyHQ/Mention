import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the LiveKit webhook auto-advance receiver. Mocks the SDK's
 * `WebhookReceiver` (so signature verification is controllable), the Room model,
 * and the shared `advancePodcastQueueForRoom` helper. Asserts the env gate, the
 * signature gate, event filtering, and that a matching `ingress_ended` triggers
 * exactly one advance/stop with the webhook actor label.
 */

const hoisted = vi.hoisted(() => ({
  receive: vi.fn(),
  advance: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock('livekit-server-sdk', () => ({
  // A class (not an arrow-returning vi.fn) so `new WebhookReceiver()` yields an
  // instance whose `receive` is our controllable mock.
  WebhookReceiver: class MockWebhookReceiver {
    receive = hoisted.receive;
  },
}));

vi.mock('../../routes/rooms.routes', () => ({
  advancePodcastQueueForRoom: hoisted.advance,
}));

vi.mock('../../models/Room', () => ({
  default: { findOne: hoisted.findOne },
}));

import livekitWebhookRouter from '../../routes/livekitWebhook.routes';

const app = express();
app.use('/livekit', livekitWebhookRouter);

function postWebhook(body: unknown) {
  return request(app)
    .post('/livekit/webhook')
    .set('Content-Type', 'application/webhook+json')
    .set('Authorization', 'signed-token')
    .send(typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  hoisted.advance.mockResolvedValue({ kind: 'ended' });
});

afterEach(() => {
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
});

describe('POST /livekit/webhook', () => {
  it('is inert (503) when LiveKit credentials are absent', async () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;

    const res = await postWebhook({ event: 'ingress_ended' });

    expect(res.status).toBe(503);
    expect(hoisted.receive).not.toHaveBeenCalled();
    expect(hoisted.advance).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 401', async () => {
    hoisted.receive.mockRejectedValue(new Error('bad signature'));

    const res = await postWebhook({ event: 'ingress_ended' });

    expect(res.status).toBe(401);
    expect(hoisted.advance).not.toHaveBeenCalled();
  });

  it('ignores non-ingress_ended events', async () => {
    hoisted.receive.mockResolvedValue({ event: 'ingress_started', ingressInfo: { ingressId: 'ing-1' } });

    const res = await postWebhook({ event: 'ingress_started' });

    expect(res.status).toBe(200);
    expect(hoisted.findOne).not.toHaveBeenCalled();
    expect(hoisted.advance).not.toHaveBeenCalled();
  });

  it('acknowledges ingress_ended with no matching room and does nothing', async () => {
    hoisted.receive.mockResolvedValue({ event: 'ingress_ended', ingressInfo: { ingressId: 'ing-1' } });
    hoisted.findOne.mockResolvedValue(null);

    const res = await postWebhook({ event: 'ingress_ended' });

    expect(res.status).toBe(200);
    expect(hoisted.findOne).toHaveBeenCalledWith({ activeIngressId: 'ing-1' });
    expect(hoisted.advance).not.toHaveBeenCalled();
  });

  it('advances the matching room on ingress_ended', async () => {
    const room = { _id: 'room-9' };
    hoisted.receive.mockResolvedValue({ event: 'ingress_ended', ingressInfo: { ingressId: 'ing-1' } });
    hoisted.findOne.mockResolvedValue(room);
    hoisted.advance.mockResolvedValue({ kind: 'started', ingressId: 'ing-2', url: 'https://x/ep.mp3' });

    const res = await postWebhook({ event: 'ingress_ended' });

    expect(res.status).toBe(200);
    expect(hoisted.advance).toHaveBeenCalledWith(room, 'room-9', 'livekit-webhook');
  });
});
