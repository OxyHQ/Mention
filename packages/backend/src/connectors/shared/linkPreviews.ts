import { normalizeInlineText } from '@oxy.so/core';
import { replacePostLinkPreviews } from '../../db/posts/postLinkPreviewRepository';
import { logger } from '../../utils/logger';

/**
 * The link card a federated post ARRIVED with, whatever the network: an
 * ActivityPub Note's FEP-8967 `Link` preview, or a Bluesky post's
 * `app.bsky.embed.external` card.
 *
 * Only the TEXT of the card is kept — `url`, `title`, `description`. A card's
 * image is a remote URL; rendering it would send every reader's request to a
 * host the author chose, so it waits for a proxied source (Clarity) instead.
 *
 * The card is the AUTHOR'S server's description of the link, not a verified
 * one, so it is only ever shown on that author's own post and only while Clarity
 * has no document for the URL (`PostHydrationService.buildClarityDocumentMap`).
 * It is never keyed by URL alone, which would let one server rewrite the card
 * of a link for every post that carries it.
 */
export interface RemoteLinkPreview {
  url: string;
  title?: string;
  description?: string;
}

const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_URL_LENGTH = 2048;

/**
 * The key two spellings of one link compare equal under: the parsed `href`, so
 * `https://Foo.example` and `https://foo.example/` meet. Text links are stored
 * as the author typed them; this is what matches a card to one.
 */
export function linkPreviewKey(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

/** A remote link worth a card: an https URL of sane length, trimmed. */
export function remoteLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  const trimmed = value.trim();
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function cardText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = normalizeInlineText(value);
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One card from its remote parts, already PLAIN text (a caller holding HTML
 * converts it first). Undefined when the URL is not an https URL, or when the
 * card has neither a title nor a description — a bare link is not a card.
 */
export function remoteLinkPreview(card: {
  url: unknown;
  title?: unknown;
  description?: unknown;
}): RemoteLinkPreview | undefined {
  const url = remoteLinkUrl(card.url);
  if (!url || !linkPreviewKey(url)) return undefined;
  const title = cardText(card.title, MAX_TITLE_LENGTH);
  const description = cardText(card.description, MAX_DESCRIPTION_LENGTH);
  if (!title && !description) return undefined;
  return { url, ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

/**
 * Store a federated post's cards, replacing any it had. Best-effort: the post is
 * already stored, and a card is a fallback — a failure here must not fail (and so
 * retry) the ingest that stored it, whose redelivery the dedup would drop anyway.
 */
export async function storeRemoteLinkPreviews(
  postId: string,
  previews: readonly RemoteLinkPreview[],
): Promise<void> {
  try {
    await replacePostLinkPreviews(postId, previews);
  } catch (error) {
    logger.warn('[Federation] could not store link previews', {
      postId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
