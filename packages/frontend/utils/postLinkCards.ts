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

/** A document's byline as a card shows it: its authors' names, joined. */
export function documentByline(document: ClarityDocument | undefined): string | undefined {
  const names = (document?.authors ?? []).map((author) => author.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : undefined;
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
 * `text` without the links its cards already show: a bare link alone on its own
 * line, wherever that line is, and a bare link that ends the text. A link inside
 * a sentence, or written as `[label](url)`, is the author's own words and stays.
 */
export function withoutCardLinks(text: string, cards: readonly PostLinkCard[]): string {
  const shown = new Set(
    cards.flatMap((card) => (card.sourceUrl ? [normalizedLinkUrl(card.sourceUrl)] : [])),
  );
  if (shown.size === 0) return text;
  const removals: Array<[number, number]> = [];
  for (const entity of scanTextEntities(text, { kinds: ['url'] })) {
    const { url } = trimUrlTrailingPunctuation(entity.value);
    if (entity.raw !== entity.value || !url || url !== entity.value) continue;
    if (!shown.has(normalizedLinkUrl(toOpenableUrl(url)))) continue;
    const lineStart = text.lastIndexOf('\n', entity.start - 1) + 1;
    const newline = text.indexOf('\n', entity.end);
    const lineEnd = newline === -1 ? text.length : newline;
    const aloneOnLine =
      text.slice(lineStart, entity.start).trim() === '' &&
      text.slice(entity.end, lineEnd).trim() === '';
    if (aloneOnLine) removals.push([lineStart, newline === -1 ? lineEnd : newline + 1]);
    else if (text.slice(entity.end).trim() === '') removals.push([entity.start, entity.end]);
  }
  if (removals.length === 0) return text;
  let result = '';
  let from = 0;
  for (const [start, end] of removals) {
    result += text.slice(from, start);
    from = end;
  }
  result += text.slice(from);
  // A removed line leaves its blank neighbours behind: one blank line is enough.
  return result.replace(/\n{3,}/g, '\n\n').trimEnd();
}
