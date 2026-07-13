import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the heavy deps BEFORE importing the router so the real PostHydrationService
// (which imports the server entrypoint) never loads — keeps this a fast, isolated
// route test. mongoose/redis/logger are already mocked in the global setup.
vi.mock('../models/Post', () => ({ Post: { findById: vi.fn() } }));
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn() },
}));

import webShellRoutes from '../routes/webShell.routes';
import { Post } from '../models/Post';
import { postHydrationService } from '../services/PostHydrationService';
import type { HydratedPost } from '@mention/shared-types';

const SHELL =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mention</title></head>' +
  '<body><div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script></body></html>';

/** A 24-hex ObjectId so the route's `mongoose.isValidObjectId` guard passes. */
const POST_ID = '507f1f77bcf86cd799439011';

function makeApp() {
  const app = express();
  app.use('/', webShellRoutes);
  return app;
}

/** Stub `global.fetch`: the shell fetch returns SHELL; the Oxy profile fetch returns `profile`. */
function stubFetch(profile: { ok: boolean; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/profiles/username/')) {
        return { ok: profile.ok, json: async () => profile.body } as Response;
      }
      return { ok: true, text: async () => SHELL } as unknown as Response;
    }),
  );
}

describe('webShell routes (integration)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('serves the shell with profile OG for a crawler /@handle request', async () => {
    stubFetch({ ok: true, body: { data: { username: 'nate', name: { displayName: 'Nate' }, bio: 'bio' } } });

    const res = await request(makeApp()).get('/@nate').set('User-Agent', 'Twitterbot/1.0');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers.vary).toContain('Accept');
    expect(res.headers.vary).toContain('User-Agent');
    expect(res.text).toContain('<meta property="og:title" content="Nate (@nate) on Mention">');
    expect(res.text).toContain('<title>Nate (@nate) on Mention</title>');
    expect(res.text).not.toContain('<title>Mention</title>');
    // Head hints are always injected (browsers benefit; crawlers ignore them).
    expect(res.text).toContain('rel="preconnect"');
  });

  it('serves the plain shell (no blocking OG) for a real browser /@handle request', async () => {
    stubFetch({ ok: true, body: { data: { username: 'nate', name: { displayName: 'Nate' }, bio: 'bio' } } });

    const res = await request(makeApp())
      .get('/@nate')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/125 Safari/537.36');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // A browser gets the untouched shell title + head hints, and NO server-side OG.
    expect(res.text).toContain('<title>Mention</title>');
    expect(res.text).not.toContain('og:title');
    expect(res.text).toContain('rel="preconnect"');
  });

  it('302-redirects a local /@handle to the AP actor when Accept wants ActivityPub', async () => {
    stubFetch({ ok: true, body: {} });

    const res = await request(makeApp()).get('/@nate').set('Accept', 'application/activity+json');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://api.mention.earth/ap/users/nate');
  });

  it('does NOT AP-redirect a federated handle (@user@domain), serving the shell instead', async () => {
    stubFetch({ ok: false });

    const res = await request(makeApp())
      .get('/@user@remote.social')
      .set('Accept', 'application/ld+json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves the shell with post OG for a crawler /p/:id request', async () => {
    stubFetch({ ok: false });
    vi.mocked(Post.findById).mockReturnValue({
      maxTimeMS: () => ({ lean: () => Promise.resolve({ _id: POST_ID, oxyUserId: 'u1', content: { text: 'hi there' } }) }),
    } as unknown as ReturnType<typeof Post.findById>);
    vi.mocked(postHydrationService.hydratePosts).mockResolvedValue([
      {
        id: POST_ID,
        user: { id: 'u1', username: 'nate', name: { displayName: 'Nate' }, avatar: 'https://cdn/a.png' },
        content: { text: 'hi there' },
      } as unknown as HydratedPost,
    ]);

    const res = await request(makeApp()).get(`/p/${POST_ID}`).set('User-Agent', 'facebookexternalhit/1.1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<meta property="og:title" content="Nate on Mention">');
    expect(res.text).toContain(`<meta property="og:url" content="https://mention.earth/p/${POST_ID}">`);
    expect(res.text).toContain('<meta property="og:image" content="https://cdn/a.png">');
  });

  it('serves the plain shell for a browser /p/:id request WITHOUT hydrating the post', async () => {
    stubFetch({ ok: false });

    const res = await request(makeApp())
      .get(`/p/${POST_ID}`)
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/125 Safari/537.36');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Mention</title>');
    expect(res.text).not.toContain('og:title');
    // The browser fast-path must never touch Mongo — no OG hydration blocks the TTFB.
    expect(vi.mocked(Post.findById)).not.toHaveBeenCalled();
    expect(vi.mocked(postHydrationService.hydratePosts)).not.toHaveBeenCalled();
  });

  it('fails open with a plain shell when a crawler requests a missing post', async () => {
    stubFetch({ ok: false });
    vi.mocked(Post.findById).mockReturnValue({
      maxTimeMS: () => ({ lean: () => Promise.resolve(null) }),
    } as unknown as ReturnType<typeof Post.findById>);

    const res = await request(makeApp()).get(`/p/${POST_ID}`).set('User-Agent', 'Slackbot-LinkExpanding 1.0');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Mention</title>');
    expect(res.text).not.toContain('og:title');
  });
});
