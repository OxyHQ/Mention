/**
 * The link cards a post renders, and the text they make redundant: ONE answer for
 * the attachment row that draws the cards and the body that trims the link they
 * already show. Two answers drifted: the row drew a card for every link in the
 * text (a source-only card when Clarity has no document, e.g. a paywalled or
 * still-indexing article) while the body trimmed only links Clarity had a
 * document for, so such a post showed the card AND the link.
 */

import { parseHomiioCaseUrl } from '@mention/shared-types/homiio';
import { type ClarityDocument, MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import {
  scanTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
} from '@mention/shared-types/textEntities';
import { extractUrls } from '@/utils/extractUrls';
import { ownProfileLinkHandle } from '@/utils/ownProfileLinks';

/** A card's identity: a document preview is shared by anchors within the page. */
export function normalizedLinkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

export interface PostLinkCard {
  /** Where the card leads: Clarity's canonical URL when it has a document. */
  url: string;
  /** The link as the post's text has it; absent for a document outside the text. */
  sourceUrl?: string;
  document?: ClarityDocument;
}

/**
 * The cards, in order: one per link in the text (with Clarity's metadata when it
 * has a document for it), then a document for a link the text does not hold.
 * Capped at `MAX_POST_DOCUMENTS`; the cap precedes the profile filter, matching
 * hydration and the composer.
 */
export function postLinkCards(
  text: string | null | undefined,
  documents: readonly ClarityDocument[] | null | undefined,
): PostLinkCard[] {
  const resolved = (documents ?? []).filter(
    (document) =>
      Boolean(document?.canonicalUrl) && parseHomiioCaseUrl(document.canonicalUrl) === null,
  );
  const byUrl = new Map<string, ClarityDocument>();
  for (const document of resolved) {
    byUrl.set(normalizedLinkUrl(document.canonicalUrl), document);
    if (document.requestedUrl) byUrl.set(normalizedLinkUrl(document.requestedUrl), document);
  }
  const sourceUrls = extractUrls(text ?? '')
    .slice(0, MAX_POST_DOCUMENTS)
    .filter((url) => ownProfileLinkHandle(url) === undefined && parseHomiioCaseUrl(url) === null);

  const seen = new Set<string>();
  const cards: PostLinkCard[] = [];
  const add = (link: string, sourceUrl: string | undefined) => {
    const document = byUrl.get(normalizedLinkUrl(link));
    const url = document?.canonicalUrl ?? link;
    const key = normalizedLinkUrl(url);
    if (seen.has(key) || cards.length >= MAX_POST_DOCUMENTS) return;
    seen.add(key);
    cards.push({ url, ...(sourceUrl ? { sourceUrl } : {}), ...(document ? { document } : {}) });
  };
  for (const sourceUrl of sourceUrls) add(sourceUrl, sourceUrl);
  for (const document of resolved) add(document.canonicalUrl, undefined);
  return cards;
}

/**
 * `text` without its last link when that link is the last thing in it (only
 * whitespace after) and one of `cards` already shows it. A link followed by more
 * words or punctuation is part of a sentence and stays.
 */
export function withoutTrailingCardLink(text: string, cards: readonly PostLinkCard[]): string {
  if (cards.length === 0) return text;
  const last = scanTextEntities(text, { kinds: ['url'] }).at(-1);
  // A bare link only: a written `[label](url)` is the author's own words.
  if (!last || last.raw !== last.value || text.slice(last.end).trim() !== '') return text;
  const { url } = trimUrlTrailingPunctuation(last.value);
  if (!url || url !== last.value) return text;
  const link = normalizedLinkUrl(toOpenableUrl(url));
  const shown = cards.some(
    (card) => card.sourceUrl !== undefined && normalizedLinkUrl(card.sourceUrl) === link,
  );
  return shown ? text.slice(0, last.start).trimEnd() : text;
}
