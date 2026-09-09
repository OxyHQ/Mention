import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PostType } from '@mention/shared-types';
import { createHash } from 'node:crypto';

/**
 * `/@handle` and `/p/:id` web-shell rendering, against REAL post rows.
 *
 * ## Why the raw row has to be real
 *
 * The OG safety verdict is deliberately read from the RAW post rather than the
 * hydrated DTO, because the DTO exposes only a subset of the sensitivity
 * signals. The previous version supplied that raw row itself — a `Post.findById`
 * double whose `lean()` returned whatever the test wrote — so every gating case
 * asserted that `requiresContentWarning` agreed with a literal, and neither the
 * lookup nor the boost's second lookup could be wrong. Both are `loadPostRecord`
 * calls now, so each case writes the post it is about.
 *
 * `postHydrationService` stays a double: it is another suite's subject, and the
 * hydrated DTO is only the SOURCE of the card's image and text here — the gate
 * that decides whether either is emitted reads the row.
 */
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn() },
}));

const { getProfileByUsername, getUsersByIds } = vi.hoisted(() => ({
  getProfileByUsername: vi.fn(),
  getUsersByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, username: 'nate', name: { displayName: 'Nate' } })),
  ),
}));

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getProfileByUsername, getUsersByIds }),
}));

import webShellRoutes from '../routes/webShell.routes';
import { postHydrationService } from '../services/PostHydrationService';
import type { HydratedPost } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../db/postgres';
import type { PostRecordInput } from '../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';

const scope = postScope('web-shell');
const AUTHOR = scope.user('author');

const SHELL =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mention</title></head>' +
  '<body><div id="root"></div><script src="/_expo/static/js/web/entry.js" defer></script></body></html>';

/** An id that matches no row — the "missing post" case, and a browser fast-path probe. */
const ABSENT_POST_ID = '019616a0-0000-7000-8000-00000000cafe';

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
        return { ok: profile.ok, status: profile.ok ? 200 : 404, json: async () => profile.body } as Response;
      }
      return { ok: true, text: async () => SHELL } as unknown as Response;
    }),
  );
}

function stubPublicAuthor() {
  stubFetch({
    ok: true,
    body: { data: { id: AUTHOR, username: 'nate', name: { displayName: 'Nate' } } },
  });
}

/** A real post row by {@link AUTHOR}. */
async function seedOgPost(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    ...overrides,
  });
  return record.id;
}

/**
 * The hydrated DTO the crawler path maps into the card.
 *
 * Written per test rather than derived, because the card's IMAGE and TEXT are
 * exactly what the gate withholds — supplying them unconditionally is what makes
 * "no image was emitted" evidence about the gate rather than about an empty DTO.
 */
function mockHydrated(id: string, overrides: Partial<HydratedPost> = {}) {
  vi.mocked(postHydrationService.hydratePosts).mockResolvedValue([
    {
      id,
      user: { id: AUTHOR, username: 'nate', name: { displayName: 'Nate' }, avatar: 'https://cdn/a.png' },
      content: { text: 'hi there' },
      ...overrides,
    } as unknown as HydratedPost,
  ]);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('webShell routes (integration)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('serves explicit crawler policy with the canonical sitemap', async () => {
    const res = await request(makeApp()).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('User-agent: *');
    expect(res.text).toContain('Content-Signal: search=yes,ai-train=no,use=reference');
    expect(res.text).toContain('Allow: /');
    expect(res.text).toContain('Sitemap: https://mention.earth/sitemap.xml');
  });

  it('retires old numeric sitemap shards without falling through to HTML', async () => {
    const res = await request(makeApp()).get('/sitemaps/posts-42.xml');

    expect(res.status).toBe(410);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(res.text).not.toContain('<html');
  });

  it('builds a stable post shard through the bulk Oxy gate without per-profile requests', async () => {
    const postId = await seedOgPost();
    const bucket = Number.parseInt(createHash('md5').update(postId).digest('hex').slice(0, 8), 16) % 64;

    const res = await request(makeApp()).get(`/sitemaps/posts-${bucket.toString(16).padStart(2, '0')}-0.xml`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.text).toContain(`https://mention.earth/p/${postId}`);
    expect(getUsersByIds).toHaveBeenCalled();
    expect(getProfileByUsername).not.toHaveBeenCalled();
  });

  it('serves the shell with profile OG for a crawler /@handle request', async () => {
    stubFetch({ ok: true, body: { data: { username: 'nate', name: { displayName: 'Nate' }, bio: 'bio' } } });

    const res = await request(makeApp()).get('/@nate').set('User-Agent', 'Twitterbot/1.0');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers.location).toBeUndefined();
    expect(res.headers.vary).toContain('Accept');
    expect(res.headers.vary).not.toContain('User-Agent');
    expect(res.text).toContain('<meta property="og:title" content="Nate (@nate) on Mention">');
    expect(res.text).toContain('<title>Nate (@nate) on Mention</title>');
    expect(res.text).not.toContain('<title>Mention</title>');
    // Head hints are always injected (browsers benefit; crawlers ignore them).
    expect(res.text).toContain('rel="preconnect"');
  });

  it('never points a federated profile card at the remote instance', async () => {
    // A federated avatar is an absolute URL on someone else's media host. Emitted
    // verbatim it made every card renderer fetch the image from that third party,
    // which is exactly what the media proxy exists to prevent — and, once the
    // bytes are mirrored, the proxy answers from our own copy instead.
    stubFetch({
      ok: true,
      body: {
        data: {
          username: 'user@remote.social',
          name: { displayName: 'User' },
          avatar: 'https://files.remote.social/avatars/1.png',
        },
      },
    });

    const res = await request(makeApp()).get('/@user@remote.social').set('User-Agent', 'Twitterbot/1.0');

    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<meta property="og:image" content="http://localhost:4110/media/proxy?url=https%3A%2F%2Ffiles.remote.social%2Favatars%2F1.png&amp;variant=w320">',
    );
    expect(res.text).not.toContain('files.remote.social/avatars');
  });

  it('serves the same semantic profile document to a real browser', async () => {
    stubFetch({ ok: true, body: { data: { username: 'nate', name: { displayName: 'Nate' }, bio: 'bio' } } });

    const res = await request(makeApp())
      .get('/@nate')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/125 Safari/537.36');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<title>Nate (@nate) on Mention</title>');
    expect(res.text).toContain('<meta property="og:title" content="Nate (@nate) on Mention">');
    expect(res.text).toContain('<link rel="canonical" href="https://mention.earth/@nate">');
    expect(res.text).toContain('<h1>Nate</h1>');
    expect(res.text).toContain('rel="preconnect"');
  });

  it('permanently redirects a channel from the person-shaped URL to its canonical URL', async () => {
    stubFetch({ ok: true, body: { data: { username: 'news', kind: 'channel' } } });

    const res = await request(makeApp()).get('/@news');

    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/c/news');
  });

  it('renders a federated profile root with accented identity in semantic HTML', async () => {
    stubFetch({
      ok: true,
      body: {
        data: {
          username: 'aida_quilcue@x.com',
          name: { displayName: 'Aida Quilcué' },
          bio: 'Lideresa indígena y defensora de derechos humanos',
        },
      },
    });

    const res = await request(makeApp()).get('/@aida_quilcue@x.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Aida Quilcué</h1>');
    expect(res.text).toContain('<link rel="canonical" href="https://mention.earth/@aida_quilcue%40x.com">');
    expect(res.text).toContain('"@type":"ProfilePage"');
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

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers.location).toBeUndefined();
  });

  it('serves the shell with post OG for a crawler /p/:id request', async () => {
    stubPublicAuthor();
    const postId = await seedOgPost();
    mockHydrated(postId);

    const res = await request(makeApp()).get(`/p/${postId}`).set('User-Agent', 'facebookexternalhit/1.1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<meta property="og:title" content="Nate on Mention">');
    expect(res.text).toContain(`<meta property="og:url" content="https://mention.earth/p/${postId}">`);
    // NOT the remote URL. A federated avatar lives on the remote instance's own
    // media host, and emitting it here made every card renderer — crawlers,
    // Slack, WhatsApp — fetch the image from that third party. Nothing outside
    // Oxy is asked for bytes on our behalf, so it goes through our proxy.
    expect(res.text).toContain(
      '<meta property="og:image" content="http://localhost:4110/media/proxy?url=https%3A%2F%2Fcdn%2Fa.png&amp;variant=w320">',
    );
    expect(res.text).not.toContain('content="https://cdn/a.png"');
  });

  it('renders an OG card for a post created AFTER the id cutover', async () => {
    // The route deliberately carries no id-shape guard: an `isValidObjectId`
    // test would refuse to render a card for every post minted since ids became
    // uuid v7, and the symptom is a silently plain shell rather than an error.
    stubPublicAuthor();
    const postId = await seedOgPost();
    expect(postId).not.toMatch(/^[a-f0-9]{24}$/);
    mockHydrated(postId);

    const res = await request(makeApp()).get(`/p/${postId}`).set('User-Agent', 'facebookexternalhit/1.1');

    expect(res.text).toContain('<meta property="og:title" content="Nate on Mention">');
  });

  it('serves the same semantic post document to a browser', async () => {
    stubPublicAuthor();
    const postId = await seedOgPost();

    const res = await request(makeApp())
      .get(`/p/${postId}`)
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/125 Safari/537.36');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Nate on Mention</title>');
    expect(res.text).toContain('<meta property="og:title" content="Nate on Mention">');
    expect(res.text).toContain('<h1>Nate on Mention</h1>');
    expect(vi.mocked(postHydrationService.hydratePosts)).toHaveBeenCalled();
  });

  it('returns a real noindex 404 for a missing post', async () => {
    stubPublicAuthor();

    const res = await request(makeApp())
      .get(`/p/${ABSENT_POST_ID}`)
      .set('User-Agent', 'Slackbot-LinkExpanding 1.0');

    expect(res.status).toBe(404);
    expect(res.text).toContain('<title>Post not found</title>');
    expect(res.text).toContain('<meta name="robots" content="noindex,nofollow">');
  });
});

/**
 * An unfurl renders at full size for everyone in a Slack/Discord/iMessage thread,
 * with no content warning and nobody having opted in — so a post that is only safe
 * behind a warning must contribute NO image and none of its body text.
 *
 * These assert on the rendered HTML rather than an internal flag: the `<meta>` tag is
 * the thing that leaks.
 */
describe('webShell post OG sensitivity gate', () => {
  const SENSITIVE_BODY = 'graphic body text nobody in the chat asked to see';

  /** A real post carrying `raw`, plus the DTO whose image and text the gate withholds. */
  async function seedGatedPost(
    raw: Partial<PostRecordInput>,
    text = SENSITIVE_BODY,
  ): Promise<string> {
    const postId = await seedOgPost(raw);
    mockHydrated(postId, {
      content: { text, media: [{ url: 'https://cdn/sensitive.jpg' }] },
    } as unknown as Partial<HydratedPost>);
    return postId;
  }

  async function crawl(postId: string) {
    return request(makeApp()).get(`/p/${postId}`).set('User-Agent', 'facebookexternalhit/1.1');
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    stubPublicAuthor();
  });

  it('emits NO og:image for a post flagged sensitive by the classifier', async () => {
    const postId = await seedGatedPost({
      postClassification: { sensitive: true, status: 'classified' },
    });

    const res = await crawl(postId);

    expect(res.text).not.toContain('og:image');
    expect(res.text).not.toContain('twitter:image');
    expect(res.text).not.toContain('https://cdn/sensitive.jpg');
    // The card must not promise a large image it is no longer sending.
    expect(res.text).toContain('<meta name="twitter:card" content="summary">');
    // Attribution and the link still go out — neither reveals what the warning covers.
    expect(res.text).toContain('<meta property="og:title" content="Nate on Mention">');
    expect(res.text).toContain(`<meta property="og:url" content="https://mention.earth/p/${postId}">`);
    expect(res.text).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  it('emits NO og:image for the legacy metadata.isSensitive flag', async () => {
    const postId = await seedGatedPost({ metadata: { isSensitive: true } });

    const res = await crawl(postId);

    expect(res.text).not.toContain('og:image');
    expect(res.text).not.toContain('https://cdn/sensitive.jpg');
  });

  it('emits NO og:image for a federated post whose origin flagged it', async () => {
    const postId = await seedGatedPost({
      federation: { activityId: `https://${scope.name}.test/a/1`, sensitive: true },
    });

    expect((await crawl(postId)).text).not.toContain('og:image');
  });

  it('emits NO og:image for a post tagged with an NSFW hashtag', async () => {
    const postId = await seedGatedPost({ hashtags: ['nsfw'] });

    expect((await crawl(postId)).text).not.toContain('og:image');
  });

  it('never unfurls the body text of a gated post', async () => {
    const postId = await seedGatedPost({ metadata: { isSensitive: true } });

    const res = await crawl(postId);

    expect(res.text).not.toContain(SENSITIVE_BODY);
    expect(res.text).toContain('This post is marked sensitive.');
  });

  it('unfurls the author’s own content warning as the description', async () => {
    const postId = await seedGatedPost({
      federation: { activityId: `https://${scope.name}.test/a/2`, spoilerText: 'CW: eye contact' },
    });

    const res = await crawl(postId);

    expect(res.text).toContain('<meta property="og:description" content="CW: eye contact">');
    expect(res.text).not.toContain(SENSITIVE_BODY);
    expect(res.text).not.toContain('og:image');
  });

  it('gates a boost whose ORIGINAL is sensitive, even though the boost row is clean', async () => {
    // A boost has an empty body and draws its description from the boosted
    // original, so a clean boost row is not enough to clear the original for
    // unfurling. This is the case that needs a SECOND real lookup: the gate must
    // load `boostOf` and judge that row too.
    const originalId = await seedOgPost({
      metadata: { isSensitive: true },
      content: { variants: [{ source: 'author', text: SENSITIVE_BODY, tag: 'en' }] },
    });
    const boostId = await seedOgPost({
      type: PostType.BOOST,
      boostOf: originalId,
      content: { variants: [{ source: 'author', text: '', tag: 'en' }] },
    });
    mockHydrated(boostId, {
      content: { text: '' },
      originalPost: { content: { text: SENSITIVE_BODY } },
    } as unknown as Partial<HydratedPost>);

    const res = await crawl(boostId);

    expect(res.text).not.toContain(SENSITIVE_BODY);
    expect(res.text).not.toContain('og:image');
  });

  it('still unfurls a boost whose original is CLEAN', async () => {
    // The vacuity floor for the case above: the boost path has to be able to
    // produce a card at all, or "no image" proves nothing about the gate.
    const originalId = await seedOgPost({
      content: { variants: [{ source: 'author', text: 'an ordinary original', tag: 'en' }] },
    });
    const boostId = await seedOgPost({
      type: PostType.BOOST,
      boostOf: originalId,
      content: { variants: [{ source: 'author', text: '', tag: 'en' }] },
    });
    mockHydrated(boostId, {
      content: { text: '', media: [{ url: 'https://cdn/ordinary.jpg' }] },
      originalPost: { content: { text: 'an ordinary original' } },
    } as unknown as Partial<HydratedPost>);

    const res = await crawl(boostId);

    expect(res.text).toContain('<meta property="og:image" content="https://cdn/ordinary.jpg">');
    expect(res.text).toContain('<meta property="og:description" content="an ordinary original">');
  });

  it('still unfurls an ordinary post with its image and text', async () => {
    const postId = await seedGatedPost({ postClassification: { status: 'baseline' } }, 'an ordinary post');

    const res = await crawl(postId);

    expect(res.text).toContain('<meta property="og:image" content="https://cdn/sensitive.jpg">');
    expect(res.text).toContain('<meta property="og:description" content="an ordinary post">');
    expect(res.text).toContain('<meta name="twitter:card" content="summary_large_image">');
  });
});
