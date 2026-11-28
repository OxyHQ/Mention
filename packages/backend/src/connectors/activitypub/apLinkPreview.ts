import { apList } from '@oxy.so/federation';
import { MAX_POST_DOCUMENTS, isRecord } from '@mention/shared-types';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { linkPreviewKey, remoteLinkPreview, type RemoteLinkPreview } from '../shared/linkPreviews';

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
 * Only `href`, `name` and `summary` are read; the card model, its limits and its
 * storage are the network-neutral ones in `connectors/shared/linkPreviews.ts`.
 */

function plainText(value: unknown): string | undefined {
  return typeof value === 'string' ? htmlToPlainText(value) : undefined;
}

/**
 * The FEP-8967 cards a Note carries, in attachment order, de-duplicated by URL
 * and capped at the number of cards a post renders. A link attachment with no
 * `preview`, or a preview with neither a title nor a description, carries no
 * card and is skipped.
 */
export function extractApLinkPreviews(object: { attachment?: unknown }): RemoteLinkPreview[] {
  const previews: RemoteLinkPreview[] = [];
  const seen = new Set<string>();
  for (const entry of apList(object.attachment)) {
    if (previews.length >= MAX_POST_DOCUMENTS) break;
    if (!isRecord(entry)) continue;
    const attachment = entry;
    const preview = attachment.preview;
    if (!isRecord(preview)) continue;
    const card = remoteLinkPreview({
      url: attachment.href,
      title: plainText(preview.name),
      description: plainText(preview.summary),
    });
    const key = card && linkPreviewKey(card.url);
    if (!card || !key || seen.has(key)) continue;
    seen.add(key);
    previews.push(card);
  }
  return previews;
}
