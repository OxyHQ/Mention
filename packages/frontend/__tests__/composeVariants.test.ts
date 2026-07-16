import { MAX_AUTHOR_VARIANTS, type PostContent } from '@mention/shared-types';
import {
  MAIN_ITEM_ID,
  buildVariantContent,
  canAddLanguage,
  createVariantsState,
  deserializeVariants,
  findVariantMissingText,
  getVariantItem,
  hasVariantWork,
  primaryTextFromPost,
  promoteVariantToPrimary,
  serializeVariants,
  variantsReducer,
  variantsStateFromPost,
  type ComposeVariantsAction,
  type ComposeVariantsState,
  type PromotablePrimary,
} from '@/utils/composeVariants';
import { buildEditPost, buildMainPost, buildThreadPost } from '@/utils/postBuilder';
import type { ThreadItem } from '@/hooks/useThreadManager';
import type { ComposerMediaItem } from '@/utils/composeUtils';

/**
 * The multilingual compose buffer.
 *
 * Two properties are load-bearing enough to be worth pinning down here:
 *
 * 1. The buffer is (item × language). A thread is already several posts; each of
 *    them now has several bodies. Flattening either axis loses an author's work.
 *
 * 2. A variant INHERITS what it does not override — and `alt` (descriptions of
 *    the SHARED images) and `media` (a replacement image set) are mutually
 *    exclusive. That is not a rule the UI is asked to respect: the two live in
 *    different arms of a union, so a variant carrying both cannot be built.
 */

const ES = 'es-ES';
const EN = 'en';

const run = (state: ComposeVariantsState, ...actions: ComposeVariantsAction[]): ComposeVariantsState =>
  actions.reduce(variantsReducer, state);

const threadItem = (overrides: Partial<ThreadItem> & { id: string }): ThreadItem => ({
  text: '',
  mediaIds: [],
  pollOptions: [],
  pollTitle: '',
  showPollCreator: false,
  location: null,
  mentions: [],
  sources: [],
  article: null,
  event: null,
  room: null,
  attachmentOrder: [],
  replyPermission: ['anyone'],
  reviewReplies: false,
  quotesDisabled: false,
  isSensitive: false,
  ...overrides,
});

const image = (id: string, alt?: string): ComposerMediaItem => ({
  id,
  type: 'image',
  ...(alt ? { alt } : {}),
});

const mainPostParams = {
  mentions: [],
  pollTitle: '',
  pollOptions: [],
  article: null,
  hasArticleContent: false,
  event: null,
  hasEventContent: false,
  room: null,
  hasRoomContent: false,
  podcast: null,
  hasPodcastContent: false,
  location: null,
  formattedSources: [],
  attachmentOrder: [],
  replyPermission: ['anyone' as const],
  reviewReplies: false,
  quotesDisabled: false,
  scheduledAt: null,
};

describe('the language tabs', () => {
  it('keeps every tab’s text when languages are added, switched and removed', () => {
    let state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'add-language', tag: 'it' },
      { type: 'set-text', tag: 'it', itemId: MAIN_ITEM_ID, text: 'Ciao' },
    );

    // Switching tabs is a read of a different slice, never a write to it.
    state = run(state, { type: 'set-active', tag: EN }, { type: 'set-active', tag: 'it' });
    expect(getVariantItem(state, EN, MAIN_ITEM_ID).text).toBe('Hello');
    expect(getVariantItem(state, 'it', MAIN_ITEM_ID).text).toBe('Ciao');

    // Removing a language deletes that language, and only that language.
    state = run(state, { type: 'remove-language', tag: 'it' });
    expect(state.variantTags).toEqual([EN]);
    expect(getVariantItem(state, 'it', MAIN_ITEM_ID).text).toBe('');
    expect(getVariantItem(state, EN, MAIN_ITEM_ID).text).toBe('Hello');
    // The removed tab was the active one, so editing falls back to the primary.
    expect(state.activeTag).toBe(ES);
  });

  it('keys renditions by (item × language), so a thread keeps a body per item per language', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'First in English' },
      { type: 'set-text', tag: EN, itemId: 'thread-1', text: 'Second in English' },
      { type: 'add-language', tag: 'it' },
      { type: 'set-text', tag: 'it', itemId: 'thread-1', text: 'Secondo in italiano' },
    );

    expect(getVariantItem(state, EN, MAIN_ITEM_ID).text).toBe('First in English');
    expect(getVariantItem(state, EN, 'thread-1').text).toBe('Second in English');
    expect(getVariantItem(state, 'it', 'thread-1').text).toBe('Secondo in italiano');
    // Italian was never written for the main post: it inherits, it does not blank.
    expect(getVariantItem(state, 'it', MAIN_ITEM_ID).text).toBe('');
  });

  it('drops a removed thread item from every language', () => {
    let state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: 'thread-1', text: 'Gone' },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Stays' },
    );

    state = run(state, { type: 'remove-item', itemId: 'thread-1' });
    expect(getVariantItem(state, EN, 'thread-1').text).toBe('');
    expect(getVariantItem(state, EN, MAIN_ITEM_ID).text).toBe('Stays');
  });

  it('canonicalizes tags and refuses invalid, duplicate, or over-cap languages', () => {
    let state = run(createVariantsState(ES), { type: 'add-language', tag: 'en-us' });
    expect(state.variantTags).toEqual(['en-US']);

    state = run(state, { type: 'add-language', tag: 'not a language' });
    expect(state.variantTags).toEqual(['en-US']);

    state = run(state, { type: 'add-language', tag: 'EN-us' });
    expect(state.variantTags).toEqual(['en-US']);

    // The cap counts the primary — it is a language of the post too.
    state = run(state, { type: 'add-language', tag: 'it' });
    expect(canAddLanguage(state)).toBe(false);
    state = run(state, { type: 'add-language', tag: 'fr' });
    expect([state.primaryTag, ...state.variantTags]).toHaveLength(MAX_AUTHOR_VARIANTS);
    expect(state.variantTags).not.toContain('fr');
  });

  it('re-tags a rendition in place, so changing a tab’s language keeps its work', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'rename-language', from: EN, to: 'pt-BR' },
    );

    expect(state.variantTags).toEqual(['pt-BR']);
    expect(state.activeTag).toBe('pt-BR');
    expect(getVariantItem(state, 'pt-BR', MAIN_ITEM_ID).text).toBe('Hello');
  });
});

describe('alt text and media on one variant', () => {
  it('cannot hold both: choosing this language’s own images discards the shared alt', () => {
    let state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'set-media-alt', tag: EN, itemId: MAIN_ITEM_ID, mediaId: 'img-1', alt: 'A chart in English' },
    );

    const inherited = getVariantItem(state, EN, MAIN_ITEM_ID).media;
    expect(inherited).toEqual({ mode: 'inherit', alt: { 'img-1': 'A chart in English' } });

    state = run(state, {
      type: 'append-media',
      tag: EN,
      itemId: MAIN_ITEM_ID,
      media: [image('img-en')],
    });

    const overridden = getVariantItem(state, EN, MAIN_ITEM_ID).media;
    expect(overridden.mode).toBe('override');
    // The union has no `alt` arm here — the descriptions of images this language
    // no longer shows are gone, not merely ignored.
    expect(overridden).not.toHaveProperty('alt');

    // An alt written now lands ON the image, which is where a replaced set keeps it.
    state = run(state, {
      type: 'set-media-alt',
      tag: EN,
      itemId: MAIN_ITEM_ID,
      mediaId: 'img-en',
      alt: 'The English chart',
    });
    expect(getVariantItem(state, EN, MAIN_ITEM_ID).media).toEqual({
      mode: 'override',
      media: [image('img-en', 'The English chart')],
    });

    const payload = buildVariantContent(state, MAIN_ITEM_ID, 'Hola', ['img-1']);
    const english = payload?.find((variant) => variant.tag === EN);
    expect(english?.media).toEqual([{ id: 'img-en', type: 'image', alt: 'The English chart' }]);
    expect(english?.alt).toBeUndefined();
  });

  it('falls back to the shared images when the last own image is removed', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'append-media', tag: EN, itemId: MAIN_ITEM_ID, media: [image('img-en')] },
      { type: 'remove-media', tag: EN, itemId: MAIN_ITEM_ID, mediaId: 'img-en' },
    );

    expect(getVariantItem(state, EN, MAIN_ITEM_ID).media).toEqual({ mode: 'inherit', alt: {} });
  });

  it('drops localized alt for images the author has since removed from the post', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'set-media-alt', tag: EN, itemId: MAIN_ITEM_ID, mediaId: 'img-1', alt: 'Still here' },
      { type: 'set-media-alt', tag: EN, itemId: MAIN_ITEM_ID, mediaId: 'img-2', alt: 'Deleted image' },
    );

    const payload = buildVariantContent(state, MAIN_ITEM_ID, 'Hola', ['img-1']);
    expect(payload?.find((variant) => variant.tag === EN)?.alt).toEqual({ 'img-1': 'Still here' });
  });
});

describe('the payload', () => {
  it('is unchanged for a post whose author never declared a language', () => {
    const state = createVariantsState(ES);
    expect(hasVariantWork(state)).toBe(false);
    expect(buildVariantContent(state, MAIN_ITEM_ID, 'Hola', [])).toBeNull();

    const post = buildMainPost({
      ...mainPostParams,
      postContent: 'Hola',
      mediaIds: [],
      variantContent: null,
    });
    expect(post.content.variants).toBeUndefined();
  });

  it('carries every author rendition, PRIMARY FIRST, when creating', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello world' },
    );

    const post = buildMainPost({
      ...mainPostParams,
      postContent: 'Hola mundo',
      mediaIds: [image('img-1')],
      variantContent: buildVariantContent(state, MAIN_ITEM_ID, 'Hola mundo', ['img-1']),
    });

    // Order IS the contract: `variants[0]` is the primary — the rendition that
    // federates and gets signed. Nothing else on the wire names it.
    expect(post.content.variants).toEqual([
      { tag: ES, source: 'author', text: 'Hola mundo' },
      { tag: EN, source: 'author', text: 'Hello world' },
    ]);
    // The primary body is also what a write sends as `content.text`.
    expect(post.content.text).toBe('Hola mundo');
  });

  it('carries every author rendition, PRIMARY FIRST, when EDITING', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello world' },
    );

    const edit = buildEditPost({
      postContent: 'Hola mundo',
      mediaIds: [image('img-1', 'Un gráfico')],
      mentions: [],
      hashtags: [],
      variantContent: buildVariantContent(state, MAIN_ITEM_ID, 'Hola mundo', ['img-1']),
    });

    expect(edit.content?.variants).toEqual([
      { tag: ES, source: 'author', text: 'Hola mundo' },
      { tag: EN, source: 'author', text: 'Hello world' },
    ]);
    expect(edit.content?.media).toEqual([{ id: 'img-1', type: 'image', alt: 'Un gráfico' }]);
  });

  it('gives each thread item its own renditions', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'First' },
      { type: 'set-text', tag: EN, itemId: 'thread-1', text: 'Second' },
    );

    const item = threadItem({ id: 'thread-1', text: 'Segundo' });
    const post = buildThreadPost(item, buildVariantContent(state, item.id, item.text, []));

    expect(post.content.variants).toEqual([
      { tag: ES, source: 'author', text: 'Segundo' },
      { tag: EN, source: 'author', text: 'Second' },
    ]);
  });

  it('omits a language the author left untouched for THIS item, so it inherits the primary body', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Only the first post is translated' },
    );

    const payload = buildVariantContent(state, 'thread-1', 'Segundo', []);
    expect(payload).toEqual([{ tag: ES, source: 'author', text: 'Segundo' }]);
  });

  it('refuses to publish a rendition that overrides images but has no body', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'append-media', tag: EN, itemId: MAIN_ITEM_ID, media: [image('img-en')] },
    );

    // A variant's text does NOT inherit — shipping this would blank the post for
    // every English reader, so the composer blocks the submit instead.
    expect(findVariantMissingText(state, { [MAIN_ITEM_ID]: 'Hola mundo' })).toBe(EN);
    // On a media-only post an empty body IS the post, so nothing is wrong.
    expect(findVariantMissingText(state, { [MAIN_ITEM_ID]: '' })).toBeNull();
  });
});

describe('drafts', () => {
  it('round-trips the buffer, including per-item alt, own media and article', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'set-primary-language', tag: 'es-ES' },
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'set-media-alt', tag: EN, itemId: MAIN_ITEM_ID, mediaId: 'img-1', alt: 'A chart' },
      { type: 'set-article', tag: EN, itemId: MAIN_ITEM_ID, article: { title: 'Title', body: 'Body' } },
      { type: 'set-text', tag: EN, itemId: 'thread-1', text: 'Second' },
      { type: 'append-media', tag: EN, itemId: 'thread-1', media: [image('img-en', 'English chart')] },
    );

    // Through JSON, because that is what AsyncStorage actually does to it.
    const restored = deserializeVariants(JSON.parse(JSON.stringify(serializeVariants(state))), 'en');

    expect(restored.primaryTag).toBe(ES);
    expect(restored.primaryChosen).toBe(true);
    expect(restored.variantTags).toEqual([EN]);
    expect(getVariantItem(restored, EN, MAIN_ITEM_ID)).toEqual({
      text: 'Hello',
      media: { mode: 'inherit', alt: { 'img-1': 'A chart' } },
      article: { title: 'Title', body: 'Body' },
    });
    expect(getVariantItem(restored, EN, 'thread-1')).toEqual({
      text: 'Second',
      media: { mode: 'override', media: [image('img-en', 'English chart')] },
      article: null,
    });
  });

  it('opens an old flat draft that predates languages, rather than throwing', () => {
    const oldDraft = {
      id: 'draft_1',
      postContent: 'Hola',
      mediaIds: [{ id: 'img-1', type: 'image' }],
      threadItems: [],
      mentions: [],
      postingMode: 'thread',
    };

    const restored = deserializeVariants(
      (oldDraft as Record<string, unknown>).languages,
      'en',
    );
    expect(restored).toEqual(createVariantsState('en'));
    expect(hasVariantWork(restored)).toBe(false);
  });

  it('degrades a corrupt blob to a clean buffer instead of losing the draft', () => {
    const corrupt = {
      primaryTag: 'not a language',
      languages: [
        { tag: 'zz-not-real', items: [{ itemId: MAIN_ITEM_ID, text: 'dropped' }] },
        { tag: EN, items: ['nonsense', { itemId: MAIN_ITEM_ID, text: 'kept', alt: { 'img-1': 42 } }] },
      ],
    };

    const restored = deserializeVariants(corrupt, ES);
    expect(restored.primaryTag).toBe(ES);
    expect(restored.variantTags).toEqual([EN]);
    expect(getVariantItem(restored, EN, MAIN_ITEM_ID)).toEqual({
      text: 'kept',
      media: { mode: 'inherit', alt: {} },
      article: null,
    });
  });
});

describe('promoting a secondary language to primary', () => {
  const primary = (text: string, media: ComposerMediaItem[] = [], article: PromotablePrimary['article'] = null): PromotablePrimary => ({
    text,
    media,
    article,
  });

  it('makes the promoted language the post’s face and demotes the old primary to a variant', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello world' },
    );

    const outcome = promoteVariantToPrimary(state, EN, { [MAIN_ITEM_ID]: primary('Hola mundo') });

    expect(outcome.state.primaryTag).toBe(EN);
    expect(outcome.state.variantTags).toEqual([ES]);
    expect(outcome.state.primaryChosen).toBe(true);
    expect(outcome.state.activeTag).toBe(EN);
    // The promoted rendition is what the composer writes back as its primary state.
    expect(outcome.primaryByItem[MAIN_ITEM_ID]).toEqual({ text: 'Hello world', media: [], article: null });

    // `variants[0]` is now the promoted language; the old primary survives as a variant.
    const payload = buildVariantContent(outcome.state, MAIN_ITEM_ID, outcome.primaryByItem[MAIN_ITEM_ID].text, []);
    expect(payload).toEqual([
      { tag: EN, source: 'author', text: 'Hello world' },
      { tag: ES, source: 'author', text: 'Hola mundo' },
    ]);
  });

  it('carries the promotion through the reducer action too', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'promote-to-primary', tag: EN, oldPrimaryByItem: { [MAIN_ITEM_ID]: primary('Hola') } },
    );

    expect(state.primaryTag).toBe(EN);
    expect(state.variantTags).toEqual([ES]);
    expect(getVariantItem(state, ES, MAIN_ITEM_ID).text).toBe('Hola');
  });

  it('promotes a language with its OWN images: they become the shared set, the old images are pinned, and inheritors keep the old ones', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'append-media', tag: EN, itemId: MAIN_ITEM_ID, media: [image('img-en', 'English chart')] },
      { type: 'add-language', tag: 'fr' },
      { type: 'set-media-alt', tag: 'fr', itemId: MAIN_ITEM_ID, mediaId: 'img-1', alt: 'Un graphique' },
    );

    const outcome = promoteVariantToPrimary(state, EN, {
      [MAIN_ITEM_ID]: primary('Hola', [image('img-1', 'Un gráfico')]),
    });

    // The promoted language's own images become the composer's shared set.
    expect(outcome.primaryByItem[MAIN_ITEM_ID].media).toEqual([image('img-en', 'English chart')]);
    // The old primary is pinned to the images it showed (as an override variant).
    expect(getVariantItem(outcome.state, ES, MAIN_ITEM_ID).media).toEqual({
      mode: 'override',
      media: [image('img-1', 'Un gráfico')],
    });
    // French inherited the OLD shared images; it keeps them (with its own alt), not the new ones.
    expect(getVariantItem(outcome.state, 'fr', MAIN_ITEM_ID).media).toEqual({
      mode: 'override',
      media: [image('img-1', 'Un graphique')],
    });
  });

  it('swaps localized alt when the shared images are unchanged', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
      { type: 'set-text', tag: EN, itemId: MAIN_ITEM_ID, text: 'Hello' },
      { type: 'set-media-alt', tag: EN, itemId: MAIN_ITEM_ID, mediaId: 'img-1', alt: 'The English chart' },
    );

    const outcome = promoteVariantToPrimary(state, EN, {
      [MAIN_ITEM_ID]: primary('Hola', [image('img-1', 'El gráfico español')]),
    });

    // The new primary keeps the shared image but now carries the promoted language's alt.
    expect(outcome.primaryByItem[MAIN_ITEM_ID].media).toEqual([image('img-1', 'The English chart')]);
    // The old primary's alt is preserved as its localized inherit map.
    expect(getVariantItem(outcome.state, ES, MAIN_ITEM_ID).media).toEqual({
      mode: 'inherit',
      alt: { 'img-1': 'El gráfico español' },
    });
  });

  it('is a no-op — same state reference — when the tag is not a current author variant', () => {
    const state = run(
      createVariantsState(ES),
      { type: 'add-language', tag: EN },
    );

    expect(promoteVariantToPrimary(state, 'de', {}).state).toBe(state);
    // The current primary is not a promotable variant either.
    expect(promoteVariantToPrimary(state, ES, {}).state).toBe(state);
  });
});

describe('editing a multilingual post', () => {
  const content: PostContent = {
    // What a hydrated post carries: the body RESOLVED for the viewer, which for
    // this bilingual author is the English one — not their primary. The primary
    // is `variants[0]`; no field names it.
    text: 'Hello world',
    textLang: EN,
    variants: [
      { tag: ES, source: 'author', text: 'Hola mundo' },
      { tag: EN, source: 'author', text: 'Hello world', alt: { 'img-1': 'A chart' } },
      { tag: 'fr', source: 'machine', text: 'Bonjour le monde' },
    ],
    media: [{ id: 'img-1', type: 'image', alt: 'Un gráfico' }],
  };

  it('loads the PRIMARY body into the composer, not the one resolved for the viewer', () => {
    expect(primaryTextFromPost(content)).toBe('Hola mundo');
  });

  it('rebuilds the author tabs and ignores the machine cache', () => {
    const state = variantsStateFromPost(content, MAIN_ITEM_ID, 'en');

    expect(state.primaryTag).toBe(ES);
    expect(state.primaryChosen).toBe(true);
    expect(state.variantTags).toEqual([EN]);
    expect(getVariantItem(state, EN, MAIN_ITEM_ID)).toEqual({
      text: 'Hello world',
      media: { mode: 'inherit', alt: { 'img-1': 'A chart' } },
      article: null,
    });
  });

  it('leaves a single-language post undeclared, so an edit does not invent a language', () => {
    const state = variantsStateFromPost({ text: 'Hola' }, MAIN_ITEM_ID, 'en');
    expect(state.primaryChosen).toBe(false);
    expect(buildVariantContent(state, MAIN_ITEM_ID, 'Hola', [])).toBeNull();
  });

  it('treats an UNTAGGED primary as no declaration — "+1" has no language to keep', () => {
    // A body too short to detect (or a federated Note that declares none) carries
    // an untagged primary. Opening the composer must not turn the app's locale
    // into a declaration the author never made and save it back on the post.
    const untagged: PostContent = {
      text: '+1',
      variants: [{ source: 'author', text: '+1' }],
    };

    const state = variantsStateFromPost(untagged, MAIN_ITEM_ID, 'en');
    expect(state.primaryChosen).toBe(false);
    expect(primaryTextFromPost(untagged)).toBe('+1');
    expect(buildVariantContent(state, MAIN_ITEM_ID, '+1', [])).toBeNull();
  });
});
