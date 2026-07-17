import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `buildCreateNoteActivity` is the SINGLE Note builder shared by push delivery,
 * the outbox page, and the per-post dereference route. These tests pin the
 * full-fidelity Note it emits — canonical `url`, hashtag `tag`s, and media
 * `attachment`s built through the canonical media chokepoint — and its fail-soft
 * behavior (a bad media item never breaks the Note).
 *
 * The builder's transitive deps (actor/crypto/queue/models) are stubbed so it
 * imports in isolation; only `resolveMediaRef` (the media chokepoint) is given
 * controllable output for attachment-URL assertions.
 */

vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery: vi.fn(), enqueueInboxActivity: vi.fn() }));
vi.mock('../../../models/FederatedActor', () => ({ default: {} }));
vi.mock('../../../models/FederatedFollow', () => ({ default: {} }));
vi.mock('../../../models/FederationDeliveryQueue', () => ({ default: {} }));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn(),
}));

// Native Oxy file id → absolute CDN URL, mirroring the real chokepoint. The
// builder only calls this for NON-absolute refs (file ids); absolute federated
// URLs bypass it and stay raw.
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
}));

import type { PostContent, PostContentVariant } from '@mention/shared-types';
import { followService } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-01-02T03:04:05.000Z';

/**
 * The post's body lives ONLY in `content.variants` — `variants[0]` is the
 * primary. This helper builds the single-rendition content most of these cases
 * need; `tag` is omitted when the post declares no language.
 */
function body(text: string, tag?: string): PostContent {
  const variant: PostContentVariant = { source: 'author', text };
  if (tag) variant.tag = tag;
  return { variants: [variant] };
}

function noteFor(post: Parameters<typeof followService.buildCreateNoteActivity>[0]) {
  const activity = followService.buildCreateNoteActivity(post, 'alice');
  return { activity, note: activity.object as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildCreateNoteActivity — canonical url + hashtag tags', () => {
  it('emits the on-site post url and a Hashtag tag per hashtag', () => {
    const { activity, note } = noteFor({
      _id: 'post123',
      content: body('hello world'),
      hashtags: ['news', 'tech'],
      createdAt: ISO,
    });

    expect(activity.type).toBe('Create');
    expect(activity.id).toBe('https://mention.earth/ap/users/alice/posts/post123/activity');
    expect(note.id).toBe('https://mention.earth/ap/users/alice/posts/post123');
    expect(note.url).toBe('https://mention.earth/@alice/posts/post123');
    // AP `content` is HTML — a single-line body is one `<p>`, no `<br>`.
    expect(note.content).toBe('<p>hello world</p>');

    expect(note.tag).toEqual([
      { type: 'Hashtag', href: 'https://mention.earth/hashtag/news', name: '#news' },
      { type: 'Hashtag', href: 'https://mention.earth/hashtag/tech', name: '#tech' },
    ]);
  });

  it('normalizes a Mongoose Date createdAt to a canonical ISO 8601 published', () => {
    const { activity, note } = noteFor({
      _id: 'p1',
      content: body('hi'),
      createdAt: new Date(ISO),
    });

    expect(activity.published).toBe(ISO);
    expect(note.published).toBe(ISO);
  });

  it('omits tag and attachment when the post has neither', () => {
    const { note } = noteFor({ _id: 'p1', content: body('plain'), createdAt: ISO });
    expect(note.tag).toBeUndefined();
    expect(note.attachment).toBeUndefined();
  });
});

describe('buildCreateNoteActivity — language + contentMap', () => {
  it('emits the primary body as `content` and EVERY author variant in `contentMap`, primary key FIRST', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        // `variants[0]` IS the primary — there is no separate `primaryTag` and no
        // stored `content.text`. The body is resolved from here at read time.
        variants: [
          { tag: 'es-ES', source: 'author', text: 'hola mundo' },
          { tag: 'en-US', source: 'author', text: 'hello world' },
        ],
      },
      createdAt: ISO,
    });

    // Mastodon renders `content` (contentMap is only its fallback for a missing
    // body) but takes the status LANGUAGE from `contentMap.keys.first`. So the
    // key order is not cosmetic: put the primary anywhere but first and the
    // status is labelled with the wrong language.
    expect(note.content).toBe('<p>hola mundo</p>');
    expect(Object.keys(note.contentMap as Record<string, string>)).toEqual(['es-ES', 'en-US']);
    // Every contentMap value is AP HTML — the localized bodies are wrapped too.
    expect(note.contentMap).toEqual({ 'es-ES': '<p>hola mundo</p>', 'en-US': '<p>hello world</p>' });
    expect(note.language).toBe('es-ES');
    // `content` and the primary contentMap key are the SAME string byte-for-byte.
    expect((note.contentMap as Record<string, string>)['es-ES']).toBe(note.content);
  });

  it('NEVER federates a machine translation — only author variants reach the wire', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        variants: [
          { tag: 'es', source: 'author', text: 'hola' },
          { tag: 'en', source: 'machine', text: 'hi (translated)' },
        ],
      },
      createdAt: ISO,
    });

    expect(note.contentMap).toEqual({ es: '<p>hola</p>' });
    expect(note.content).toBe('<p>hola</p>');
  });

  it('emits a single-key contentMap for a monolingual post — the only way Mastodon learns the language', () => {
    const { note } = noteFor({ _id: 'p1', content: body('just english', 'en'), createdAt: ISO });

    expect(note.contentMap).toEqual({ en: '<p>just english</p>' });
    expect(note.language).toBe('en');
  });

  it('federates an UNTAGGED body with no language claim rather than inventing one', () => {
    // A body too short to detect a language in ("ok", "+1", a bare URL), or a post
    // whose language never resolved. The body still federates; we simply do not
    // claim to know what language it is in. Inventing one would be a lie that
    // Mastodon would then display as fact.
    const { note } = noteFor({ _id: 'p1', content: body('+1'), createdAt: ISO });

    expect(note.content).toBe('<p>+1</p>');
    expect(note.contentMap).toBeUndefined();
    expect(note.language).toBeUndefined();
  });

  it('emits no body and no language for a post with no rendition at all (a boost)', () => {
    const { note } = noteFor({ _id: 'p1', content: { variants: [] }, createdAt: ISO });

    expect(note.content).toBe('');
    expect(note.contentMap).toBeUndefined();
    expect(note.language).toBeUndefined();
  });

  it('canonicalizes tags on the way out (`es-es` → `es-ES`) and drops an invalid one', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        variants: [
          { tag: 'es-es', source: 'author', text: 'hola' },
          { tag: 'not a language', source: 'author', text: 'garbage' },
        ],
      },
      createdAt: ISO,
    });

    // An invalid BCP-47 key gets a Mastodon status rejected wholesale, so it
    // never reaches the wire.
    expect(note.contentMap).toEqual({ 'es-ES': '<p>hola</p>' });
    expect(note.language).toBe('es-ES');
  });
});

describe('buildCreateNoteActivity — plain-text body → AP HTML content', () => {
  it('wraps blank-line-separated paragraphs in <p> so Mastodon preserves them (regression)', () => {
    // The bug: raw `\n\n` is insignificant whitespace in HTML, so Mastodon
    // collapsed the author's blank lines and the paragraphs ran together.
    const { note } = noteFor({
      _id: 'p1',
      content: body('hola mundo.\n\nAhora otra cosa.\n\nPorque sí.', 'es'),
      createdAt: ISO,
    });

    expect(note.content).toBe('<p>hola mundo.</p><p>Ahora otra cosa.</p><p>Porque sí.</p>');
    // The single contentMap value is the same HTML, byte-for-byte.
    expect((note.contentMap as Record<string, string>).es).toBe(note.content);
  });

  it('converts a single newline inside a paragraph to <br>', () => {
    const { note } = noteFor({ _id: 'p1', content: body('line one\nline two'), createdAt: ISO });
    expect(note.content).toBe('<p>line one<br>line two</p>');
  });

  it('HTML-escapes < & > in the body so they never mis-render as markup', () => {
    const { note } = noteFor({ _id: 'p1', content: body('a < b && c > d'), createdAt: ISO });
    expect(note.content).toBe('<p>a &lt; b &amp;&amp; c &gt; d</p>');
  });

  it('keeps an empty-bodied post (a boost) empty — no stray tags', () => {
    const { note } = noteFor({ _id: 'p1', content: { variants: [] }, createdAt: ISO });
    expect(note.content).toBe('');
  });
});

describe('buildCreateNoteActivity — media attachments', () => {
  it('builds Document attachments: native ids via the chokepoint, federated raw urls verbatim', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        ...body('with media'),
        media: [
          { id: 'file-abc', type: 'image', alt: 'a cat' },
          { id: 'https://remote.example/pic.png', type: 'image' },
          { id: 'vid-xyz', type: 'video' },
        ],
      },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      // Native file id → resolved CDN url (no extension → category default), alt → name.
      { type: 'Document', mediaType: 'image/jpeg', url: 'https://cloud.oxy.so/file-abc', name: 'a cat' },
      // Federated raw url stays raw; extension .png → precise mediaType; no alt → no name.
      { type: 'Document', mediaType: 'image/png', url: 'https://remote.example/pic.png' },
      // Native video id → category default video/mp4.
      { type: 'Document', mediaType: 'video/mp4', url: 'https://cloud.oxy.so/vid-xyz' },
    ]);
  });

  it('is fail-soft: skips a media item with an empty id but keeps the good ones', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        ...body('partial'),
        media: [
          { id: '', type: 'image' },
          { id: 'file-ok', type: 'gif' },
        ],
      },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      { type: 'Document', mediaType: 'image/gif', url: 'https://cloud.oxy.so/file-ok' },
    ]);
  });
});

describe('buildCreateNoteActivity — the PRIMARY rendition is what federates', () => {
  it('sends the primary variant’s media override, not the shared set', () => {
    // AS2 has ONE attachment set. A post whose primary language uses a different
    // infographic must federate THAT one — the shared set is what the other
    // languages fall back to, not what the author leads with.
    const { note } = noteFor({
      _id: 'p1',
      content: {
        media: [{ id: 'file-shared', type: 'image' }],
        variants: [
          { tag: 'es', source: 'author', text: 'hola', media: [{ id: 'file-es', type: 'image' }] },
          { tag: 'en', source: 'author', text: 'hi' },
        ],
      },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      { type: 'Document', mediaType: 'image/jpeg', url: 'https://cloud.oxy.so/file-es' },
    ]);
  });

  it('localizes the alt text of the SHARED media for the primary language', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: {
        media: [{ id: 'file-shared', type: 'image', alt: 'a cat' }],
        variants: [{ tag: 'es', source: 'author', text: 'hola', alt: { 'file-shared': 'un gato' } }],
      },
      createdAt: ISO,
    });

    // The AP `name` on the attachment is the accessibility description, and it
    // must be in the same language as the body it ships with.
    expect(note.attachment).toEqual([
      { type: 'Document', mediaType: 'image/jpeg', url: 'https://cloud.oxy.so/file-shared', name: 'un gato' },
    ]);
  });
});

describe('buildCreateNoteActivity — sensitive flag', () => {
  it('emits sensitive:true when the author flagged the post sensitive', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: body('behind a warning'),
      createdAt: ISO,
      metadata: { isSensitive: true },
    });

    expect(note.sensitive).toBe(true);
    // Boolean-only toggle → never a `summary` (there is no CW text to carry).
    expect(note.summary).toBeUndefined();
  });

  it('emits sensitive:false for a normal post (no metadata, or the flag unset)', () => {
    const { note } = noteFor({ _id: 'p1', content: body('safe'), createdAt: ISO });
    expect(note.sensitive).toBe(false);

    const { note: explicit } = noteFor({
      _id: 'p2',
      content: body('safe'),
      createdAt: ISO,
      metadata: { isSensitive: false },
    });
    expect(explicit.sensitive).toBe(false);
  });
});

describe('buildCreateNoteActivity — media width/height', () => {
  it('emits width and height on an attachment when both are present on the item', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: { ...body('sized'), media: [{ id: 'file-abc', type: 'image', width: 1200, height: 800 }] },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      { type: 'Document', mediaType: 'image/jpeg', url: 'https://cloud.oxy.so/file-abc', width: 1200, height: 800 },
    ]);
  });

  it('omits the width/height keys entirely when the item carries no dimensions', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: { ...body('unsized'), media: [{ id: 'file-abc', type: 'image' }] },
      createdAt: ISO,
    });

    const [attachment] = note.attachment as Array<Record<string, unknown>>;
    expect(attachment).not.toHaveProperty('width');
    expect(attachment).not.toHaveProperty('height');
    expect(attachment).toEqual({
      type: 'Document',
      mediaType: 'image/jpeg',
      url: 'https://cloud.oxy.so/file-abc',
    });
  });

  it('emits only the present dimension and never a zero placeholder', () => {
    const { note } = noteFor({
      _id: 'p1',
      content: { ...body('half sized'), media: [{ id: 'file-abc', type: 'image', width: 640, height: 0 }] },
      createdAt: ISO,
    });

    expect(note.attachment).toEqual([
      { type: 'Document', mediaType: 'image/jpeg', url: 'https://cloud.oxy.so/file-abc', width: 640 },
    ]);
  });
});

describe('buildCreateNoteActivity — source plaintext', () => {
  it('carries the RAW primary body as source (text/plain), NOT the HTML content', () => {
    const { note } = noteFor({ _id: 'p1', content: body('line one\nline two'), createdAt: ISO });

    // `content` is HTML (the newline became a <br>); `source.content` is the
    // author's raw plaintext, so an edit-fetching client recovers the original.
    expect(note.content).toBe('<p>line one<br>line two</p>');
    expect(note.source).toEqual({ content: 'line one\nline two', mediaType: 'text/plain' });
  });

  it('omits source for an empty body (a boost)', () => {
    const { note } = noteFor({ _id: 'p1', content: { variants: [] }, createdAt: ISO });
    expect(note.source).toBeUndefined();
  });
});

describe('buildUpdateNoteActivity — inherits sensitive + source from the Note', () => {
  it('the embedded Update object carries the same sensitive flag and raw source body', () => {
    const activity = followService.buildUpdateNoteActivity(
      { _id: 'p1', content: body('edited body'), createdAt: ISO, metadata: { isSensitive: true } },
      'alice',
    );
    const note = activity.object as Record<string, unknown>;

    expect(note.sensitive).toBe(true);
    expect(note.source).toEqual({ content: 'edited body', mediaType: 'text/plain' });
  });
});
