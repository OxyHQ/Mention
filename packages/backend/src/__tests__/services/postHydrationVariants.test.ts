import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaItem, PostContentVariant, PostUser, StoredPostContent } from '@mention/shared-types';

/**
 * The DTO contract that makes multilingual posts cheap: hydration resolves the
 * reader's language ON THE SERVER, so `content.text` — which NINE renderers read
 * directly (video captions, notification previews, quote cards, the share sheet,
 * SEO, the server-rendered OG, MCP) — is already the right language, and none of
 * them has to know this feature exists.
 *
 * `content.text` exists ONLY here, in the served DTO. Storage keeps the body once,
 * on the rendition it belongs to.
 *
 * `buildContent` is private, so it is exercised through a precise structural
 * interface (no `as any`), the same harness the podcast attachment test uses.
 */

vi.mock('../../../server', () => ({ oxy: { getUserById: vi.fn() } }));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn(),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));
vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../models/Poll', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/UserSettings', () => ({ UserSettings: {} }));
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

import { PostHydrationService } from '../../services/PostHydrationService';
import { resolveVariant, resolveViewerTag } from '../../services/postVariants';

interface ContentBuilder {
  buildContent(
    post: { content?: Partial<StoredPostContent> },
    pollMap: Map<string, Record<string, unknown>>,
    viewerContext: { includeFullArticleBody?: boolean } | undefined,
    resolved: ReturnType<typeof resolveVariant>,
    inlineVariants: PostContentVariant[] | undefined,
  ): Record<string, unknown>;
  buildInlineVariants(
    content: StoredPostContent,
    servedTag: string | undefined,
    postMentions: string[],
    mentionCache: Map<string, PostUser>,
    includeFullArticleBody: boolean,
  ): Promise<PostContentVariant[] | undefined>;
}

function asBuilder(service: PostHydrationService): ContentBuilder {
  return service as unknown as ContentBuilder;
}

/** Hydrate `content` the way the service does, for a reader with `candidates`. */
async function hydrateContent(
  service: PostHydrationService,
  content: StoredPostContent,
  candidates: string[],
): Promise<Record<string, unknown>> {
  const builder = asBuilder(service);
  const resolved = resolveVariant(content, resolveViewerTag(candidates, content));
  const inline = await builder.buildInlineVariants(content, resolved.tag, [], new Map(), true);
  return builder.buildContent({ content }, new Map(), { includeFullArticleBody: true }, resolved, inline);
}

const media: MediaItem[] = [{ id: 'img-1', type: 'image', alt: 'A cat' }];

const bilingual: StoredPostContent = {
  media,
  variants: [
    { tag: 'es-ES', source: 'author', text: 'Hola mundo' },
    { tag: 'en-US', source: 'author', text: 'Hello world', alt: { 'img-1': 'Un gato' } },
  ],
};

describe('PostHydrationService — localized content DTO', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    service = new PostHydrationService();
  });

  it('serves the reader’s language in content.text and names it in textLang', async () => {
    const english = await hydrateContent(service, bilingual, ['en-GB']);

    expect(english.text).toBe('Hello world');
    expect(english.textLang).toBe('en-US');
  });

  it('serves the primary to a reader with no language preference (crawler, OG, MCP)', async () => {
    const anonymous = await hydrateContent(service, bilingual, []);

    expect(anonymous.text).toBe('Hola mundo');
    expect(anonymous.textLang).toBe('es-ES');
  });

  it('localizes the alt text of the SHARED images for the language served', async () => {
    const english = await hydrateContent(service, bilingual, ['en-US']);
    const spanish = await hydrateContent(service, bilingual, ['es-ES']);

    const englishMedia = english.media as MediaItem[];
    const spanishMedia = spanish.media as MediaItem[];

    expect(englishMedia[0].alt).toBe('Un gato');
    expect(spanishMedia[0].alt).toBe('A cat');
  });

  it('ships the author renditions inline so the reader can switch language with no round trip', async () => {
    const dto = await hydrateContent(service, bilingual, ['en-US']);
    const variants = dto.variants as PostContentVariant[];

    expect(variants.map((variant) => variant.tag)).toEqual(['es-ES', 'en-US']);
    // The rendition that overrides its media carries the RESOLVED result, so the
    // client swaps in what it is handed and never re-implements the inheritance rule.
    expect(variants[1].media?.[0].alt).toBe('Un gato');
    expect(variants[0].media).toBeUndefined();
  });

  it('omits variants entirely on a monolingual post — its one rendition IS content.text', async () => {
    const monolingual: StoredPostContent = {
      variants: [{ tag: 'es-ES', source: 'author', text: 'Hola mundo' }],
    };

    const dto = await hydrateContent(service, monolingual, ['es-ES']);

    expect(dto.variants).toBeUndefined();
    expect(dto.text).toBe('Hola mundo');
    expect(dto.textLang).toBe('es-ES');
  });

  it('serves a machine translation when the reader’s language is one the author did not write', async () => {
    const withMachine: StoredPostContent = {
      ...bilingual,
      variants: [
        ...(bilingual.variants ?? []),
        { tag: 'de-DE', source: 'machine', text: 'Hallo Welt' },
      ],
    };

    const dto = await hydrateContent(service, withMachine, ['de-AT']);
    const variants = dto.variants as PostContentVariant[];

    expect(dto.text).toBe('Hallo Welt');
    expect(dto.textLang).toBe('de-DE');
    // The served machine rendition ships alongside the author's, so the reader can
    // switch back to the original.
    expect(variants.map((variant) => variant.tag)).toEqual(['es-ES', 'en-US', 'de-DE']);
  });

  it('does not advertise the machine translations the reader is NOT being served', async () => {
    const withMachine: StoredPostContent = {
      ...bilingual,
      variants: [
        ...(bilingual.variants ?? []),
        { tag: 'de-DE', source: 'machine', text: 'Hallo Welt' },
      ],
    };

    const dto = await hydrateContent(service, withMachine, ['es-ES']);
    const variants = dto.variants as PostContentVariant[];

    expect(variants.every((variant) => variant.source === 'author')).toBe(true);
  });
});
