/**
 * WHICH PROFILE LINKS IN A BODY BEING COMPOSED COULD BECOME MENTIONS.
 *
 * A profile link the author pastes is folded into the post's real mentions at the
 * write boundary — the id lands in `post.mentions`, which puts the post in that
 * person's mentions feed and notifies them. The composer therefore has to be able
 * to SAY so before the author sends, or pasting a URL rings somebody's phone with
 * nothing on screen having said it would.
 *
 * This module answers only the syntactic half: which URLs in the body are
 * candidates, and how many of them the write boundary has room for. WHETHER a
 * candidate becomes a mention is a different question — it depends on whether we
 * hold the account it names — and it is asked against stored identities by
 * `hooks/useProfileLinkMentions`. Nothing here (or there) ever fetches the pasted
 * URL: dereferencing author-controlled text would make every keystroke a request
 * to a host of the author's choosing.
 *
 * THE COUNTING MIRRORS THE WRITE BOUNDARY DELIBERATELY. The composer must never
 * promise a mention the server will not store, and the cheapest way to promise
 * one by accident is to disagree about the ceiling: a body already carrying its
 * full complement of picked mentions has no room left, so a link pasted into it
 * stays a link and the composer must stay silent about it.
 */

import { MAX_MENTIONS_PER_POST, reconcileMentionIds } from '@mention/shared-types/mentions';
import { extractUrls } from '@/utils/extractUrls';
import { ownProfileLinkHandle } from '@/utils/ownProfileLinks';

/**
 * Max distinct profile links one body's mentions may come from.
 *
 * Mirrors `MAX_PROFILE_LINKS_PER_BODY` in the server's `profileLinkMentions`
 * service, which is the number that actually binds. It is duplicated rather than
 * imported because that module is server-side; the two belong together in
 * `@mention/shared-types/mentions` next to {@link MAX_MENTIONS_PER_POST}, and
 * should be moved there when both halves ship. Until then the value is pinned by
 * a test, so a change on one side shows up as a failure rather than as a
 * composer that quietly over-promises.
 */
export const MAX_PROFILE_LINKS_PER_BODY = 8;

/** A URL in the body that names a profile on this instance. */
export interface ComposerProfileLink {
  /** The normalized, openable URL, exactly as the resolver will be asked about it. */
  url: string;
  /** The handle its path names. Not yet known to belong to anybody. */
  handle: string;
}

/**
 * The profile links in a post's bodies that could still become mentions, in
 * reading order.
 *
 * `texts` is every rendition the author wrote for ONE post — its primary body and
 * its language variants — because that is the set the write boundary reads and
 * the set the ceiling is measured across. A link in the Spanish variant competes
 * for the same room as one in the primary.
 *
 * Headroom is measured against the mentions the bodies ALREADY carry (ids that
 * both have a placeholder in the text and are authorized), not against the raw
 * registry, which may still name people the author has since deleted from the
 * text. Beyond the headroom the surplus links stay ordinary links — so they are
 * not returned, and nothing on screen claims them.
 *
 * Pure, and cheap enough to run on every keystroke: one entity scan per rendition
 * and a `URL` parse per extracted link, no I/O.
 */
export function composerProfileLinks(
  texts: readonly string[],
  mentionIds: readonly string[],
): ComposerProfileLink[] {
  const headroom = MAX_MENTIONS_PER_POST - reconcileMentionIds(texts, mentionIds).length;
  const limit = Math.min(MAX_PROFILE_LINKS_PER_BODY, headroom);
  if (limit <= 0) return [];

  const seen = new Set<string>();
  const links: ComposerProfileLink[] = [];
  for (const text of texts) {
    for (const url of extractUrls(text)) {
      const handle = ownProfileLinkHandle(url);
      if (!handle) continue;
      // Distinct URLs, matching how the write boundary spends its budget: two
      // spellings of one profile (`/@alice` and `/ap/users/alice`) each cost a
      // lookup there, so they each cost a slot here.
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ url, handle });
      if (links.length >= limit) return links;
    }
  }
  return links;
}
