/**
 * The machine-translation cache, against real rows.
 *
 * Hydration SELECTS the reader's rendition from what the post stores; only the
 * explicit `POST /posts/:id/translate` path (PostTranslationService.translatePost)
 * pays for inference, and it caches the result as a `source: 'machine'` variant
 * under the canonical EXACT BCP-47 tag. This suite pins the three things a cache
 * like that gets wrong silently:
 *
 *  - the cache key: `es-MX` and `es-ES` are separate rows with separate text, and
 *    a base-only `es` stays `es`;
 *  - the races: concurrent requests pay for one inference and converge on one row,
 *    and an author edit that lands mid-translation never leaves a translation of
 *    the OLD body behind;
 *  - the shape: localized ALT text is stored in `post_variant_alt_texts`, so it
 *    survives a fresh read — not only the immediate translation response.
 *
 * Oxy (identity) and the inference edge are remote services and stay mocked;
 * everything Mention stores is real.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUsersByIds, cacheStore, inferenceChat } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  inferenceChat: vi.fn(),
}));

vi.mock('../../utils/oxyInference', () => ({ inferenceChat }));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getClarityDocuments: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import type { MediaItem, PostContentVariant, StoredPostContent } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants, postVariantAltTexts } from '../../db/schema/postContent';
import { loadPostRecord, replacePostContent } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';
import {
  PostTranslationService,
  TranslationSourceChangedError,
  translationSourceFingerprint,
} from '../../services/PostTranslationService';

const scope = postScope('translation-cache');
const AUTHOR_ID = scope.user('author');

type ChatMessage = { role: string; content: string };

/**
 * A deterministic stand-in for the model: it "translates" by prefixing the
 * language name, so every stored string says which source it was made from.
 * Body calls wrap the text in `<text>`; keyed calls carry a JSON object.
 */
const displayName = (tag: string): string =>
  new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
/** ICU's names vary by version ("Mexican Spanish"); the assertions use stable labels. */
const LABELS = new Map([
  [displayName('es-MX'), 'Spanish (Mexico)'],
  [displayName('es-ES'), 'Spanish (Spain)'],
  [displayName('es'), 'Spanish'],
]);

function fakeTranslate(messages: ChatMessage[]): string {
  const prompt = messages[messages.length - 1]?.content ?? '';
  const named = /to (.+?):\n/.exec(prompt)?.[1] ?? '?';
  const language = LABELS.get(named) ?? named;
  const body = /<text>\n([\s\S]*)\n<\/text>/.exec(prompt);
  if (body) return `[${language}] ${body[1]}`;
  const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as Record<string, string>;
  return JSON.stringify(
    Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, `[${language}] ${value}`])),
  );
}

/** How many BODY translations the model was asked for (keyed calls excluded). */
function bodyCalls(): number {
  return inferenceChat.mock.calls.filter(([, options]) => options?.feature === 'post-translation').length;
}

/** Every non-test `.ts` file under `dir`. */
function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listSources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const media: MediaItem[] = [
  { id: 'translation-cache-img-1', type: 'image', alt: 'A red car' },
  { id: 'translation-cache-img-2', type: 'image', alt: 'A parking lot' },
];

function englishPost(text = 'I bought a car'): Partial<StoredPostContent> {
  return { variants: [{ tag: 'en-US', source: 'author', text }] };
}

async function seed(content: StoredPostContent): Promise<PostRecord> {
  return seedPost(scope, { oxyUserId: AUTHOR_ID, content });
}

async function fresh(postId: string): Promise<PostRecord> {
  const record = await loadPostRecord(postId);
  if (!record) throw new Error(`post ${postId} vanished`);
  return record;
}

async function machineRows(postId: string) {
  return getDb()
    .select()
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId))
    .orderBy(asc(postContentVariants.position));
}

describe('machine translation cache', () => {
  let hydration: PostHydrationService;
  let translation: PostTranslationService;

  /** Hydrate a FRESH read of the post for a reader whose request carries `languages`. */
  async function hydrate(postId: string, languages: string[]) {
    const [dto] = await hydration.hydratePosts([await fresh(postId)], {
      viewerId: undefined,
      requestLanguages: languages,
      oxyClient: {
        getUsersByIds,
        getClarityDocuments: vi.fn(async () => ({})),
        getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
      } as never,
      maxDepth: 0,
      includeLinkMetadata: false,
      includeCommunityNotes: false,
    });
    if (!dto) throw new Error('hydration dropped the post');
    return dto as unknown as {
      content: { text: string; textLang?: string; media?: MediaItem[]; article?: { title?: string; excerpt?: string } };
    };
  }

  beforeAll(async () => {
    await connectPostgres();
  });

  beforeEach(() => {
    cacheStore.clear();
    inferenceChat.mockReset();
    inferenceChat.mockImplementation(async (messages: ChatMessage[]) => fakeTranslate(messages));
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([
      { id: AUTHOR_ID, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false },
    ]);
    hydration = new PostHydrationService();
    translation = new PostTranslationService();
  });

  afterEach(async () => {
    await clearPostScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  describe('hydration selects, it never translates', () => {
    it('has exactly one caller of translatePost: the explicit translate controller', () => {
      const srcRoot = path.resolve(__dirname, '../..');
      const callers = listSources(srcRoot)
        .filter((file) => /\.translatePost\(/.test(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(srcRoot, file));
      expect(callers).toEqual([path.join('controllers', 'posts', 'translation.ts')]);

      const hydrationSource = fs.readFileSync(path.join(srcRoot, 'services', 'PostHydrationService.ts'), 'utf8');
      expect(hydrationSource).not.toMatch(/PostTranslationService|oxyInference/);
    });

    it('serves exact, then same-base, then the primary — with zero inference calls', async () => {
      const post = await seed({
        variants: [
          { tag: 'en-US', source: 'author', text: 'I bought a car' },
          { tag: 'es-ES', source: 'author', text: 'Me he comprado un coche' },
          { tag: 'es-MX', source: 'machine', text: 'Me compré un carro' },
        ],
      });

      expect((await hydrate(post.id, ['es-MX'])).content.text).toBe('Me compré un carro');
      expect((await hydrate(post.id, ['es-ES'])).content.text).toBe('Me he comprado un coche');
      // A different region with no rendition of its own: the AUTHOR same-base one.
      expect((await hydrate(post.id, ['es-AR'])).content.text).toBe('Me he comprado un coche');
      // Nothing in the reader's language: the primary, not a fresh translation.
      expect((await hydrate(post.id, ['ja-JP'])).content.text).toBe('I bought a car');
      expect((await hydrate(post.id, [])).content.text).toBe('I bought a car');

      expect(inferenceChat).not.toHaveBeenCalled();
    });

    it('falls back to a same-base MACHINE rendition when no author one exists', async () => {
      const post = await seed({
        variants: [
          { tag: 'en-US', source: 'author', text: 'I bought a car' },
          { tag: 'es-ES', source: 'machine', text: 'Me he comprado un coche' },
        ],
      });

      expect((await hydrate(post.id, ['es-MX'])).content.text).toBe('Me he comprado un coche');
      expect(inferenceChat).not.toHaveBeenCalled();
    });
  });

  describe('POST /posts/:id/translate caches by the exact tag', () => {
    it('stores es-MX and es-ES as separate machine rows and serves each to its own reader', async () => {
      const post = await seed(englishPost());

      const mexico = await translation.translatePost(post.id, post.content, 'es_mx');
      const spain = await translation.translatePost(post.id, (await fresh(post.id)).content, 'es-ES');

      expect(mexico).toEqual({ text: '[Spanish (Mexico)] I bought a car', tag: 'es-MX', cached: false });
      expect(spain).toEqual({ text: '[Spanish (Spain)] I bought a car', tag: 'es-ES', cached: false });

      const rows = await machineRows(post.id);
      expect(rows.map((row) => [row.position, row.tag, row.source])).toEqual([
        [0, 'en-US', 'author'],
        [1, 'es-MX', 'machine'],
        [2, 'es-ES', 'machine'],
      ]);

      inferenceChat.mockClear();
      expect((await hydrate(post.id, ['es-MX'])).content.text).toBe('[Spanish (Mexico)] I bought a car');
      expect((await hydrate(post.id, ['es-ES'])).content.text).toBe('[Spanish (Spain)] I bought a car');
      expect(inferenceChat).not.toHaveBeenCalled();
    });

    it('answers a repeat request from the cache without calling the model', async () => {
      const post = await seed(englishPost());
      await translation.translatePost(post.id, post.content, 'es-MX');
      inferenceChat.mockClear();

      const again = await translation.translatePost(post.id, (await fresh(post.id)).content, 'es-MX');

      expect(again).toEqual({ text: '[Spanish (Mexico)] I bought a car', tag: 'es-MX', cached: true });
      expect(inferenceChat).not.toHaveBeenCalled();
    });

    it('caches a base-only request under the base tag — no region is invented', async () => {
      const post = await seed(englishPost());

      const result = await translation.translatePost(post.id, post.content, 'es');

      expect(result.tag).toBe('es');
      expect((await machineRows(post.id)).map((row) => row.tag)).toEqual(['en-US', 'es']);
      expect((await hydrate(post.id, ['es'])).content.textLang).toBe('es');
    });

    it('never machine-translates over an author rendition of the same tag', async () => {
      const post = await seed({
        variants: [
          { tag: 'en-US', source: 'author', text: 'I bought a car' },
          { tag: 'es-MX', source: 'author', text: 'Me compré un carro (del autor)' },
        ],
      });

      const result = await translation.translatePost(post.id, post.content, 'es-MX', { force: true });

      expect(result).toEqual({ text: 'Me compré un carro (del autor)', tag: 'es-MX', cached: true });
      expect(inferenceChat).not.toHaveBeenCalled();
    });
  });

  describe('concurrent requests for the same post and locale', () => {
    it('pays for ONE inference and hands every caller the same persisted result', async () => {
      const post = await seed(englishPost());

      const results = await Promise.all(
        Array.from({ length: 5 }, () => translation.translatePost(post.id, post.content, 'es-MX')),
      );

      expect(bodyCalls()).toBe(1);
      expect(new Set(results.map((result) => result.text))).toEqual(new Set(['[Spanish (Mexico)] I bought a car']));
      expect((await machineRows(post.id)).filter((row) => row.source === 'machine')).toHaveLength(1);
    });

    it('converges on the first stored row when two PROCESSES race — never a 500', async () => {
      const post = await seed(englishPost());
      // Two service instances have no in-process single-flight in common: this is
      // the cross-task race, and only the database can settle it.
      const other = new PostTranslationService();
      let call = 0;
      inferenceChat.mockImplementation(async (messages: ChatMessage[]) => {
        call += 1;
        return `${fakeTranslate(messages)} #${call}`;
      });

      const [first, second] = await Promise.all([
        translation.translatePost(post.id, post.content, 'es-MX'),
        other.translatePost(post.id, post.content, 'es-MX'),
      ]);

      const machine = (await machineRows(post.id)).filter((row) => row.source === 'machine');
      expect(machine).toHaveLength(1);
      expect(first.text).toBe(machine[0]?.body);
      expect(second.text).toBe(machine[0]?.body);
    });
  });

  describe('an author edit racing an in-flight translation', () => {
    /** Hold every body translation until `release` is called. */
    function gateInference(): { started: Promise<void>; release: () => void } {
      let release!: () => void;
      let signalStarted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      let held = false;
      inferenceChat.mockImplementation(async (messages: ChatMessage[], options?: { feature?: string }) => {
        if (options?.feature === 'post-translation' && !held) {
          held = true;
          signalStarted();
          await gate;
        }
        return fakeTranslate(messages);
      });
      return { started, release };
    }

    async function edit(postId: string, text: string): Promise<void> {
      const current = await fresh(postId);
      // What `updatePost` does to renditions on a body edit: the author's new
      // body, every machine translation dropped.
      await replacePostContent(postId, {
        ...current.content,
        variants: [{ tag: 'en-US', source: 'author', text }],
      }, current.mentions ?? []);
    }

    it('does not cache the stale translation; it translates the NEW source instead', async () => {
      const post = await seed(englishPost('I bought a car'));
      const { started, release } = gateInference();

      const pending = translation.translatePost(post.id, post.content, 'es-MX');
      await started;
      await edit(post.id, 'I sold my car');
      release();
      const result = await pending;

      const machine = (await machineRows(post.id)).filter((row) => row.source === 'machine');
      expect(machine.map((row) => row.body)).toEqual(['[Spanish (Mexico)] I sold my car']);
      expect(result).toEqual({ text: '[Spanish (Mexico)] I sold my car', tag: 'es-MX', cached: false });
      expect(bodyCalls()).toBe(2);
    });

    it('fails with a typed conflict — and stores nothing — when the source changes again during the retry', async () => {
      const post = await seed(englishPost('I bought a car'));
      let edits = 0;
      inferenceChat.mockImplementation(async (messages: ChatMessage[], options?: { feature?: string }) => {
        // Every body translation is overtaken by an author edit.
        if (options?.feature === 'post-translation') {
          edits += 1;
          await edit(post.id, `edit number ${edits}`);
        }
        return fakeTranslate(messages);
      });

      await expect(translation.translatePost(post.id, post.content, 'es-MX'))
        .rejects.toBeInstanceOf(TranslationSourceChangedError);

      expect((await machineRows(post.id)).filter((row) => row.source === 'machine')).toEqual([]);
    });

    it('fingerprints only what is translated: body, shown media alt text, and the article', () => {
      const base: StoredPostContent = { ...englishPost(), media, article: { title: 'T', excerpt: 'E' } };
      const fingerprint = translationSourceFingerprint(base);

      expect(translationSourceFingerprint({
        ...base,
        media: media.map((item) => ({ ...item, width: 640, height: 480 })),
        variants: [...(base.variants ?? []), { tag: 'de', source: 'machine', text: 'x' }],
      })).toBe(fingerprint);

      expect(translationSourceFingerprint({ ...base, ...englishPost('changed') })).not.toBe(fingerprint);
      expect(translationSourceFingerprint({ ...base, media: [{ ...media[0]!, alt: 'changed' }, media[1]!] }))
        .not.toBe(fingerprint);
      expect(translationSourceFingerprint({ ...base, article: { title: 'changed', excerpt: 'E' } }))
        .not.toBe(fingerprint);
    });
  });

  describe('localized ALT text is stored, not only returned', () => {
    it('round-trips body + article + shared-media ALT through a fresh read and hydration', async () => {
      const post = await seed({
        ...englishPost(),
        media,
        article: { title: 'Car diary', excerpt: 'Day one' },
      });

      await translation.translatePost(post.id, post.content, 'es-MX');

      const stored = (await fresh(post.id)).content.variants?.find(
        (variant: PostContentVariant) => variant.source === 'machine',
      );
      expect(stored).toMatchObject({
        tag: 'es-MX',
        text: '[Spanish (Mexico)] I bought a car',
        alt: {
          'translation-cache-img-1': '[Spanish (Mexico)] A red car',
          'translation-cache-img-2': '[Spanish (Mexico)] A parking lot',
        },
        article: { title: '[Spanish (Mexico)] Car diary', excerpt: '[Spanish (Mexico)] Day one' },
      });

      inferenceChat.mockClear();
      const dto = await hydrate(post.id, ['es-MX']);
      expect(dto.content.text).toBe('[Spanish (Mexico)] I bought a car');
      expect(dto.content.media?.map((item) => item.alt)).toEqual([
        '[Spanish (Mexico)] A red car',
        '[Spanish (Mexico)] A parking lot',
      ]);
      expect(dto.content.article).toMatchObject({
        title: '[Spanish (Mexico)] Car diary',
        excerpt: '[Spanish (Mexico)] Day one',
      });
      expect(inferenceChat).not.toHaveBeenCalled();

      // The English reader still sees the author's own descriptions.
      const english = await hydrate(post.id, ['en-US']);
      expect(english.content.media?.map((item) => item.alt)).toEqual(['A red car', 'A parking lot']);
    });

    it('replaces a forced machine variant’s ALT rows together with the variant', async () => {
      const post = await seed({ ...englishPost(), media });
      await translation.translatePost(post.id, post.content, 'es-MX');
      const [before] = (await machineRows(post.id)).filter((row) => row.source === 'machine');

      inferenceChat.mockImplementation(async (messages: ChatMessage[]) =>
        fakeTranslate(messages).replaceAll('[Spanish (Mexico)]', '[v2]'));
      await translation.translatePost(post.id, (await fresh(post.id)).content, 'es-MX', { force: true });

      const machine = (await machineRows(post.id)).filter((row) => row.source === 'machine');
      expect(machine).toHaveLength(1);
      expect(machine[0]?.body).toBe('[v2] I bought a car');

      const altRows = await getDb()
        .select({ variantId: postVariantAltTexts.variantId, description: postVariantAltTexts.description })
        .from(postVariantAltTexts)
        .where(inArray(postVariantAltTexts.variantId, [before!.id, machine[0]!.id]))
        .orderBy(asc(postVariantAltTexts.mediaId));
      expect(altRows).toEqual([
        { variantId: machine[0]!.id, description: '[v2] A red car' },
        { variantId: machine[0]!.id, description: '[v2] A parking lot' },
      ]);
    });
  });
});
