import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import worker from '../packages/frontend/worker/index.js';

test('shell access gate and streaming stay intact with telemetry disabled', async () => {
  const ctx = { waitUntil() { throw new Error('disabled telemetry scheduled work'); } };
  let assets = 0;
  const response = new Response('private shell');
  const env = { ASSETS: { fetch: async () => { assets++; return response; } } };
  assert.equal((await worker.fetch(new Request('https://shell.mention.earth/'), env, ctx)).status, 503);
  env.SHELL_ACCESS_KEY = 'test-shell-key';
  const denied = await worker.fetch(new Request('https://shell.mention.earth/'), env, ctx);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(assets, 0);
  const previous = crypto.subtle.timingSafeEqual;
  crypto.subtle.timingSafeEqual = timingSafeEqual;
  try {
    const request = new Request('https://shell.mention.earth/', { headers: { 'x-mention-shell-key': env.SHELL_ACCESS_KEY } });
    assert.equal(await worker.fetch(request, env, ctx), response);
    assert.equal(assets, 1);
  } finally {
    if (previous === undefined) delete crypto.subtle.timingSafeEqual;
    else crypto.subtle.timingSafeEqual = previous;
  }
});


test('enabled edge producer publishes actual media operations without a dashboard viewer', async () => {
  const originalFetch = globalThis.fetch;
  const originalCompare = crypto.subtle.timingSafeEqual;
  const publications = [];
  const pending = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/service-token') return Response.json({ token: 'test-token', expiresIn: 3600 });
    publications.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  };
  try {
    const env = { OXY_EDGE_ACTIVITY_ENABLED: 'true', OXY_EDGE_ACTIVITY_API_KEY: 'key', OXY_EDGE_ACTIVITY_API_SECRET: 'secret', ASSETS: { fetch: async () => new Response('image', { headers: { 'content-type': 'image/png' } }) } };
    const request = new Request('https://example.test/private-image.png');
    Object.defineProperty(request, 'cf', { value: { colo: 'MAD' } });
    env.SHELL_ACCESS_KEY = 'test-shell-key'; request.headers.set('x-mention-shell-key', env.SHELL_ACCESS_KEY);
    crypto.subtle.timingSafeEqual = timingSafeEqual;
    const response = await worker.fetch(request, env, { waitUntil(promise) { pending.push(promise); } });
    assert.equal(await response.text(), 'image');
    await Promise.all(pending);
    const events = publications.flat();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => [event.service, event.region, event.scope, event.direction, event.activityType]), [
      ['mention', 'edge-mad', 'internal', 'inbound', 'media'],
      ['mention', 'edge-mad', 'internal', 'outbound', 'media'],
    ]);
    assert.equal(events[0].sourceService, 'mention');
    assert.doesNotMatch(JSON.stringify(events), /private-image|secret/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCompare === undefined) delete crypto.subtle.timingSafeEqual;
    else crypto.subtle.timingSafeEqual = originalCompare;
  }
});
