import {
  canonicalizeLanguageTag,
  MAX_AUTHOR_VARIANTS,
  type MediaItem,
  type PostContent,
  type PostContentVariant,
} from '@mention/shared-types';
import { toComposerMediaType, type ComposerMediaItem, type ComposerMediaType } from './composeUtils';

/**
 * The multilingual compose buffer.
 *
 * The buffer is TWO-DIMENSIONAL: a composer already holds several posts (the
 * main one plus every thread item), and each of those now holds several
 * languages. The key is therefore (item × language), never one flattened into
 * the other.
 *
 * The PRIMARY language's content is not stored here — it stays in the composer's
 * existing state (`postContent`, `mediaIds`, `article`, `threadItems[]`). That
 * is the same shape the model has: the primary IS the post, and a variant is a
 * localized rendition of it. Only the renditions live in this module.
 *
 * Everything here is pure, so the buffer's behaviour is testable without
 * mounting the composer. `useComposeVariants` is a thin `useReducer` over it.
 */

/** The composer item a rendition belongs to: the main post, or a thread item id. */
export const MAIN_ITEM_ID = 'main';

export interface ComposeVariantArticle {
  title: string;
  body: string;
}

/**
 * How a rendition treats the post's media.
 *
 * THE RULE — a variant inherits everything it does not override — is encoded in
 * the type itself. Localized descriptions of the SHARED images (`alt`) and a
 * replacement image set (`media`) live in different arms of this union, so a
 * variant carrying both is not merely discouraged: it cannot be represented.
 * When the set is replaced, each {@link ComposerMediaItem} carries its own alt,
 * which is why a second alt map would be a second source of truth.
 */
export type ComposeVariantMedia =
  | { mode: 'inherit'; alt: Record<string, string> }
  | { mode: 'override'; media: ComposerMediaItem[] };

export interface ComposeVariantItem {
  text: string;
  media: ComposeVariantMedia;
  /** Localized long-form. `null` inherits the shared article. */
  article: ComposeVariantArticle | null;
}

export interface ComposeVariantsState {
  /** The language the author writes in: the one that federates and gets signed. */
  primaryTag: string;
  /** The other author languages, in tab order. */
  variantTags: string[];
  /** The language currently being edited across every composer item. */
  activeTag: string;
  /** language → item → rendition. Only non-primary languages have entries. */
  entries: Record<string, Record<string, ComposeVariantItem>>;
  /**
   * Whether the author explicitly picked the primary language.
   *
   * The composer OPENS on the app's UI locale, which is a preference, not a
   * declaration: a user reading Mention in English who writes in Spanish must
   * not have their post declared English. So the default alone never reaches the
   * wire — see {@link hasDeclaredLanguages}.
   */
  primaryChosen: boolean;
}

export const EMPTY_VARIANT_ITEM: ComposeVariantItem = {
  text: '',
  media: { mode: 'inherit', alt: {} },
  article: null,
};

export function createVariantsState(primaryTag: string): ComposeVariantsState {
  return {
    primaryTag,
    variantTags: [],
    activeTag: primaryTag,
    entries: {},
    primaryChosen: false,
  };
}

// ── Selectors ───────────────────────────────────────────────────────────────

/** Every author language of this post, primary first. */
export function allTags(state: ComposeVariantsState): string[] {
  return [state.primaryTag, ...state.variantTags];
}

/** The rendition of one item in one language. Never `undefined`. */
export function getVariantItem(
  state: ComposeVariantsState,
  tag: string,
  itemId: string,
): ComposeVariantItem {
  return state.entries[tag]?.[itemId] ?? EMPTY_VARIANT_ITEM;
}

/** Whether a rendition holds anything at all. An untouched tab is not content. */
export function hasVariantContent(item: ComposeVariantItem): boolean {
  if (item.text.trim().length > 0) return true;
  if (item.article && (item.article.title.trim().length > 0 || item.article.body.trim().length > 0)) return true;
  if (item.media.mode === 'override') return item.media.media.length > 0;
  return Object.values(item.media.alt).some((alt) => alt.trim().length > 0);
}

/** Whether any language other than the primary holds work worth keeping. */
export function hasVariantWork(state: ComposeVariantsState): boolean {
  return Object.values(state.entries).some((items) => Object.values(items).some(hasVariantContent));
}

/** The author-variant cap counts the primary — it is a language of the post too. */
export function canAddLanguage(state: ComposeVariantsState): boolean {
  return allTags(state).length < MAX_AUTHOR_VARIANTS;
}

/** A language already in use cannot be added again, nor become the primary. */
export function isTagInUse(state: ComposeVariantsState, tag: string): boolean {
  return allTags(state).includes(tag);
}

/**
 * Whether the author DECLARED this post's languages — the only case in which the
 * composer sends `content.variants` at all.
 *
 * Declaring a language is authoritative: the classifier trusts it over its own
 * detection. Sending the UI locale for authors who never opened the language
 * picker would therefore mislabel every post written in a language other than
 * the app's — a wrong `postClassification.languages` is what feed retrieval
 * matches on, so the post would be served to the wrong audience. Silence (and
 * server-side detection, exactly as today) is the correct payload until the
 * author says otherwise.
 */
export function hasDeclaredLanguages(state: ComposeVariantsState): boolean {
  return state.primaryChosen || state.variantTags.length > 0;
}

/**
 * The first rendition that overrides media/alt/article but has no text, while
 * the primary body DOES have text.
 *
 * Such a variant cannot be published: a variant's `text` does not inherit (the
 * reader is served the variant's body verbatim), so shipping it would blank the
 * post for that whole language. Rather than silently dropping the author's alt
 * and image work, the composer blocks the submit and says which language needs a
 * body. Returns the offending language tag, or `null` when every variant is fine.
 */
export function findVariantMissingText(
  state: ComposeVariantsState,
  primaryTexts: Record<string, string>,
): string | null {
  for (const tag of state.variantTags) {
    const items = state.entries[tag];
    if (!items) continue;
    for (const [itemId, item] of Object.entries(items)) {
      const primaryText = primaryTexts[itemId];
      if (primaryText === undefined) continue; // Item no longer exists.
      if (item.text.trim().length > 0) continue;
      if (primaryText.trim().length === 0) continue; // Media-only post: an empty body is the post.
      if (hasVariantContent(item)) return tag;
    }
  }
  return null;
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export type ComposeVariantsAction =
  | { type: 'set-active'; tag: string }
  | { type: 'add-language'; tag: string }
  | { type: 'remove-language'; tag: string }
  /** Re-tags a rendition IN PLACE — the author's work in that tab survives. */
  | { type: 'rename-language'; from: string; to: string }
  | { type: 'set-primary-language'; tag: string }
  | { type: 'set-text'; tag: string; itemId: string; text: string }
  /** Writes the alt of ONE image, into whichever arm the rendition is in. */
  | { type: 'set-media-alt'; tag: string; itemId: string; mediaId: string; alt: string }
  /** Attaching an image to a rendition IS the act of replacing the media set. */
  | { type: 'append-media'; tag: string; itemId: string; media: ComposerMediaItem[] }
  | { type: 'remove-media'; tag: string; itemId: string; mediaId: string }
  | { type: 'inherit-media'; tag: string; itemId: string }
  | { type: 'set-article'; tag: string; itemId: string; article: ComposeVariantArticle | null }
  | { type: 'remove-item'; itemId: string }
  | { type: 'load'; state: ComposeVariantsState }
  | { type: 'reset'; primaryTag: string };

function withItem(
  state: ComposeVariantsState,
  tag: string,
  itemId: string,
  update: (item: ComposeVariantItem) => ComposeVariantItem,
): ComposeVariantsState {
  if (!state.variantTags.includes(tag)) return state;
  const items = state.entries[tag] ?? {};
  const next = update(items[itemId] ?? EMPTY_VARIANT_ITEM);
  return {
    ...state,
    entries: { ...state.entries, [tag]: { ...items, [itemId]: next } },
  };
}

export function variantsReducer(
  state: ComposeVariantsState,
  action: ComposeVariantsAction,
): ComposeVariantsState {
  switch (action.type) {
    case 'set-active': {
      if (!isTagInUse(state, action.tag)) return state;
      return { ...state, activeTag: action.tag };
    }

    case 'add-language': {
      const tag = canonicalizeLanguageTag(action.tag);
      if (tag === null || isTagInUse(state, tag) || !canAddLanguage(state)) return state;
      return {
        ...state,
        variantTags: [...state.variantTags, tag],
        entries: { ...state.entries, [tag]: {} },
        activeTag: tag,
      };
    }

    case 'remove-language': {
      if (!state.variantTags.includes(action.tag)) return state;
      const entries = { ...state.entries };
      delete entries[action.tag];
      return {
        ...state,
        variantTags: state.variantTags.filter((tag) => tag !== action.tag),
        entries,
        activeTag: state.activeTag === action.tag ? state.primaryTag : state.activeTag,
      };
    }

    case 'rename-language': {
      const to = canonicalizeLanguageTag(action.to);
      if (to === null || !state.variantTags.includes(action.from) || isTagInUse(state, to)) return state;
      const { [action.from]: items, ...rest } = state.entries;
      return {
        ...state,
        variantTags: state.variantTags.map((tag) => (tag === action.from ? to : tag)),
        entries: { ...rest, [to]: items ?? {} },
        activeTag: state.activeTag === action.from ? to : state.activeTag,
      };
    }

    case 'set-primary-language': {
      const tag = canonicalizeLanguageTag(action.tag);
      if (tag === null || state.variantTags.includes(tag)) return state;
      // Picking the language the composer already OPENED on is not a no-op: it is
      // the author confirming what they are writing in, which is exactly the act
      // that turns a default into a declaration.
      return {
        ...state,
        primaryTag: tag,
        primaryChosen: true,
        activeTag: state.activeTag === state.primaryTag ? tag : state.activeTag,
      };
    }

    case 'set-text':
      return withItem(state, action.tag, action.itemId, (item) => ({ ...item, text: action.text }));

    case 'set-media-alt':
      return withItem(state, action.tag, action.itemId, (item) => {
        const alt = action.alt.trim();
        if (item.media.mode === 'override') {
          return {
            ...item,
            media: {
              mode: 'override',
              media: item.media.media.map((media) =>
                media.id === action.mediaId
                  ? { ...media, alt: alt.length > 0 ? alt : undefined }
                  : media,
              ),
            },
          };
        }
        const next = { ...item.media.alt };
        if (alt.length > 0) {
          next[action.mediaId] = alt;
        } else {
          delete next[action.mediaId];
        }
        return { ...item, media: { mode: 'inherit', alt: next } };
      });

    case 'append-media':
      // Attaching an image to a rendition replaces the media set for that
      // language, which DISCARDS the localized alt of the shared set: those
      // descriptions belonged to images this language no longer shows.
      return withItem(state, action.tag, action.itemId, (item) => {
        const current = item.media.mode === 'override' ? item.media.media : [];
        const existing = new Set(current.map((media) => media.id));
        const added = action.media.filter((media) => !existing.has(media.id));
        return { ...item, media: { mode: 'override', media: [...current, ...added] } };
      });

    case 'remove-media':
      // Removing the last own image is the author saying they no longer want a
      // different set — fall back to the shared media rather than leaving the
      // language with no images at all.
      return withItem(state, action.tag, action.itemId, (item) => {
        if (item.media.mode !== 'override') return item;
        const media = item.media.media.filter((entry) => entry.id !== action.mediaId);
        return {
          ...item,
          media: media.length > 0 ? { mode: 'override', media } : { mode: 'inherit', alt: {} },
        };
      });

    case 'inherit-media':
      return withItem(state, action.tag, action.itemId, (item) => ({
        ...item,
        media: { mode: 'inherit', alt: {} },
      }));

    case 'set-article':
      return withItem(state, action.tag, action.itemId, (item) => ({ ...item, article: action.article }));

    case 'remove-item': {
      const entries: ComposeVariantsState['entries'] = {};
      for (const [tag, items] of Object.entries(state.entries)) {
        const { [action.itemId]: _removed, ...rest } = items;
        entries[tag] = rest;
      }
      return { ...state, entries };
    }

    case 'load':
      return action.state;

    case 'reset':
      return createVariantsState(action.primaryTag);
  }
}

// ── Payload ─────────────────────────────────────────────────────────────────

function toMediaItem(media: ComposerMediaItem): MediaItem {
  const alt = media.alt?.trim();
  return {
    id: media.id,
    type: media.type,
    ...(media.type === 'image' && alt ? { alt } : {}),
  };
}

function articlePayload(
  article: ComposeVariantArticle | null,
): PostContentVariant['article'] | undefined {
  if (!article) return undefined;
  const title = article.title.trim();
  const body = article.body.trim();
  if (!title && !body) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
}

/**
 * The `content.variants` of ONE composer item (main post or thread item).
 *
 * **The first entry is the primary** — the rendition that federates, gets signed,
 * and that every other language falls back to. Order carries that fact; nothing
 * else does, which is why there is no `primaryTag` on the wire to disagree with
 * it. Renditions the author left untouched for this item are omitted: a reader in
 * that language then inherits the primary body, which is the truthful answer for
 * a thread item that was never translated.
 *
 * Returns `null` when the author declared nothing, which keeps the payload of an
 * ordinary single-language post byte-for-byte what it is today — and leaves the
 * language to the server's detector rather than to the app's UI locale.
 */
export function buildVariantContent(
  state: ComposeVariantsState,
  itemId: string,
  primaryText: string,
  sharedMediaIds: readonly string[],
): PostContentVariant[] | null {
  if (!hasDeclaredLanguages(state)) return null;

  const variants: PostContentVariant[] = [
    { tag: state.primaryTag, source: 'author', text: primaryText.trim() },
  ];

  for (const tag of state.variantTags) {
    const item = state.entries[tag]?.[itemId];
    if (!item || !hasVariantContent(item)) continue;

    const article = articlePayload(item.article);

    if (item.media.mode === 'override') {
      variants.push({
        tag,
        source: 'author',
        text: item.text.trim(),
        media: item.media.media.map(toMediaItem),
        ...(article ? { article } : {}),
      });
      continue;
    }

    // Alt entries for images the author has since removed would describe media
    // this post no longer has — drop them at the boundary.
    const alt: Record<string, string> = {};
    for (const mediaId of sharedMediaIds) {
      const description = item.media.alt[mediaId]?.trim();
      if (description) alt[mediaId] = description;
    }

    variants.push({
      tag,
      source: 'author',
      text: item.text.trim(),
      ...(Object.keys(alt).length > 0 ? { alt } : {}),
      ...(article ? { article } : {}),
    });
  }

  return variants;
}

// ── Edit-mode hydration ─────────────────────────────────────────────────────

function toComposerMedia(media: MediaItem): ComposerMediaItem {
  return {
    id: media.id,
    type: toComposerMediaType(media.type, media.mime),
    ...(media.alt ? { alt: media.alt } : {}),
  };
}

/**
 * The AUTHOR renditions of a post being edited, primary first. The composer only
 * ever edits what the author wrote, so the machine translations the server may
 * have attached for this reader are skipped: they are a cache, not authorship.
 */
function authorVariants(content: PostContent | undefined): PostContentVariant[] {
  return (content?.variants ?? []).filter((variant) => variant.source === 'author');
}

/**
 * The primary body of a post being edited.
 *
 * On a hydrated post `content.text` is the body ALREADY RESOLVED for the
 * viewer's language — which for a bilingual author editing their own post can be
 * the English rendition of a post whose primary is Spanish. `variants[0]` is the
 * primary, so it is the authoritative body whenever the post has renditions.
 */
export function primaryTextFromPost(content: PostContent | undefined): string {
  return authorVariants(content)[0]?.text ?? content?.text ?? '';
}

/**
 * Rebuild the compose buffer from a post being edited.
 *
 * The primary is `variants[0]` — position, not a tag field, is what names it. A
 * primary with NO tag means the post has no resolvable language (a body too short
 * to detect, a federated Note that declares none); that is not a declaration, so
 * the composer opens undeclared rather than inventing a tag the author never
 * chose and stamping it on the post at the next save.
 */
export function variantsStateFromPost(
  content: PostContent | undefined,
  itemId: string,
  fallbackPrimaryTag: string,
): ComposeVariantsState {
  const [primary, ...rest] = authorVariants(content);
  const primaryTag = canonicalizeLanguageTag(primary?.tag);
  if (primaryTag === null) return createVariantsState(fallbackPrimaryTag);

  const state: ComposeVariantsState = {
    primaryTag,
    variantTags: [],
    activeTag: primaryTag,
    entries: {},
    primaryChosen: true,
  };

  for (const variant of rest) {
    const tag = canonicalizeLanguageTag(variant.tag);
    if (tag === null || tag === primaryTag || state.variantTags.includes(tag)) continue;
    if (state.variantTags.length + 1 >= MAX_AUTHOR_VARIANTS) break;

    const media: ComposeVariantMedia = variant.media
      ? { mode: 'override', media: variant.media.map(toComposerMedia) }
      : { mode: 'inherit', alt: { ...(variant.alt ?? {}) } };

    state.variantTags.push(tag);
    state.entries[tag] = {
      [itemId]: {
        text: variant.text,
        media,
        article: variant.article
          ? { title: variant.article.title ?? '', body: variant.article.body ?? '' }
          : null,
      },
    };
  }

  return state;
}

// ── Drafts ──────────────────────────────────────────────────────────────────

/**
 * The variant buffer as it is persisted in a draft.
 *
 * Drafts are stored raw in AsyncStorage and are NOT versioned, so this shape is
 * additive and its reader ({@link deserializeVariants}) is tolerant: a draft
 * written before this feature existed simply has no `languages` key and must
 * still open.
 */
interface DraftVariantMedia {
  id: string;
  type: ComposerMediaType;
  alt?: string;
}

interface DraftVariantItem {
  itemId: string;
  text: string;
  alt?: Record<string, string>;
  media?: DraftVariantMedia[];
  article?: { title: string; body: string };
}

export interface DraftVariants {
  primaryTag: string;
  primaryChosen: boolean;
  languages: { tag: string; items: DraftVariantItem[] }[];
}

export function serializeVariants(state: ComposeVariantsState): DraftVariants {
  return {
    primaryTag: state.primaryTag,
    primaryChosen: state.primaryChosen,
    languages: state.variantTags.map((tag) => ({
      tag,
      items: Object.entries(state.entries[tag] ?? {})
        .filter(([, item]) => hasVariantContent(item))
        .map(([itemId, item]) => ({
          itemId,
          text: item.text,
          ...(item.media.mode === 'override'
            ? { media: item.media.media.map((media) => ({ id: media.id, type: media.type, ...(media.alt ? { alt: media.alt } : {}) })) }
            : { alt: item.media.alt }),
          ...(item.article ? { article: item.article } : {}),
        })),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim().length > 0) map[key] = entry;
  }
  return map;
}

function readDraftMedia(value: unknown): ComposerMediaItem[] | null {
  if (!Array.isArray(value)) return null;
  const media: ComposerMediaItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue;
    media.push({
      id: entry.id,
      type: toComposerMediaType(typeof entry.type === 'string' ? entry.type : undefined),
      ...(typeof entry.alt === 'string' && entry.alt.trim().length > 0 ? { alt: entry.alt } : {}),
    });
  }
  return media;
}

/**
 * Read a draft's variant buffer. Never throws and never rejects a draft: an old
 * flat draft, a truncated write, or a hand-edited storage entry all degrade to a
 * clean single-language buffer rather than costing the author their draft.
 */
export function deserializeVariants(value: unknown, fallbackPrimaryTag: string): ComposeVariantsState {
  if (!isRecord(value)) return createVariantsState(fallbackPrimaryTag);

  const primaryTag = canonicalizeLanguageTag(value.primaryTag) ?? fallbackPrimaryTag;
  const state = createVariantsState(primaryTag);
  state.primaryChosen = value.primaryChosen === true;

  const languages = Array.isArray(value.languages) ? value.languages : [];
  for (const language of languages) {
    if (!isRecord(language)) continue;
    const tag = canonicalizeLanguageTag(language.tag);
    if (tag === null || tag === primaryTag || state.variantTags.includes(tag)) continue;
    if (state.variantTags.length + 1 >= MAX_AUTHOR_VARIANTS) break;

    const items: Record<string, ComposeVariantItem> = {};
    const rawItems = Array.isArray(language.items) ? language.items : [];
    for (const rawItem of rawItems) {
      if (!isRecord(rawItem) || typeof rawItem.itemId !== 'string' || rawItem.itemId.length === 0) continue;
      const override = readDraftMedia(rawItem.media);
      const article = isRecord(rawItem.article)
        ? {
            title: typeof rawItem.article.title === 'string' ? rawItem.article.title : '',
            body: typeof rawItem.article.body === 'string' ? rawItem.article.body : '',
          }
        : null;
      items[rawItem.itemId] = {
        text: typeof rawItem.text === 'string' ? rawItem.text : '',
        media: override ? { mode: 'override', media: override } : { mode: 'inherit', alt: readStringMap(rawItem.alt) },
        article: article && (article.title || article.body) ? article : null,
      };
    }

    state.variantTags.push(tag);
    state.entries[tag] = items;
  }

  return state;
}
