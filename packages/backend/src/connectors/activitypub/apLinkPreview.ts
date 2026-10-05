import { MAX_POST_DOCUMENTS } from '@mention/shared-types';
import { normalizeInlineText } from '@oxy.so/core';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { replacePostLinkPreviews } from '../../db/posts/postLinkPreviewRepository';
import { logger } from '../../utils/logger';

/**
 * FEP-8967 link previews on an inbound Note.
 *
 * A server that implements FEP-8967 (Mastodon 4.7 among them) attaches each
 * previewed link as a `Link` in `attachment`, with the card it rendered as
 * `preview`:
 *
 *   "attachment": [{ "type": "Link", "href": "https://foo.example/",
 *                    "preview": { "type": "Article", "name": "…", "summary": "…" } }]
 *
 * Only the TEXT of the card is kept — `href`, `name`, `summary`. The preview's
 * `image` and the author `icon` are remote URLs; rendering them would send every
 * reader's request to a host the author chose, so they wait for a proxied
 * source (Clarity) instead.
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

function httpsUrl(value: unknown): string | undefined {
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
  const text = normalizeInlineText(htmlToPlainText(value));
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The FEP-8967 cards a Note carries, in attachment order, de-duplicated by URL
 * and capped at the number of cards a post renders. A link attachment with no
 * `preview`, or a preview with neither a title nor a description, carries no
 * card and is skipped.
 */
export function extractApLinkPreviews(object: { attachment?: unknown }): RemoteLinkPreview[] {
  const entries = Array.isArray(object.attachment) ? object.attachment : [object.attachment];
  const previews: RemoteLinkPreview[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (previews.length >= MAX_POST_DOCUMENTS) break;
    const attachment = asRecord(entry);
    const preview = asRecord(attachment?.preview);
    if (!attachment || !preview) continue;
    const url = httpsUrl(attachment.href);
    const key = url && linkPreviewKey(url);
    if (!url || !key || seen.has(key)) continue;
    const title = cardText(preview.name, MAX_TITLE_LENGTH);
    const description = cardText(preview.summary, MAX_DESCRIPTION_LENGTH);
    if (!title && !description) continue;
    seen.add(key);
    previews.push({ url, ...(title ? { title } : {}), ...(description ? { description } : {}) });
  }
  return previews;
}

/**
 * Store a federated post's cards, replacing any it had. Best-effort: the post is
 * already stored, and a card is a fallback — a failure here must not fail (and so
 * retry) the ingest that stored it, whose redelivery the dedup would drop anyway.
 */
export async function storeRemoteLinkPreviews(postId: string, previews: readonly RemoteLinkPreview[]): Promise<void> {
  try {
    await replacePostLinkPreviews(postId, previews);
  } catch (error) {
    logger.warn('[Federation] could not store link previews', {
      postId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
