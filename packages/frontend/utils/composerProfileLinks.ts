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
 * hold the account it names — and it is asked of the server by
 * `hooks/useProfileLinkMentions`, which is the only side that can answer for a
 * link on another host. Nothing here (or there) ever fetches the pasted URL:
 * dereferencing author-controlled text would make every keystroke a request to a
 * host of the author's choosing.
 *
 * THE COUNTING MIRRORS THE WRITE BOUNDARY DELIBERATELY. The composer must never
 * promise a mention the server will not store, and the cheapest way to promise
 * one by accident is to disagree about the ceiling: a body already carrying its
 * full complement of picked mentions has no room left, so a link pasted into it
 * stays a link and the composer must stay silent about it.
 */

import {
  MAX_MENTIONS_PER_POST,
  MAX_PROFILE_LINKS_PER_BODY,
  reconcileMentionIds,
} from '@mention/shared-types/mentions';
import { isProfileLikeUrl } from '@mention/shared-types/profileUrls';
import { extractUrls } from '@/utils/extractUrls';
import { OWN_PROFILE_HOSTS } from '@/utils/ownProfileLinks';

/**
 * The profile links in a post's bodies that could still become mentions, in
 * reading order — normalized, openable URLs, exactly as the resolver will be
 * asked about them.
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
): string[] {
  const headroom = MAX_MENTIONS_PER_POST - reconcileMentionIds(texts, mentionIds).length;
  const limit = Math.min(MAX_PROFILE_LINKS_PER_BODY, headroom);
  if (limit <= 0) return [];

  const seen = new Set<string>();
  const links: string[] = [];
  for (const text of texts) {
    for (const url of extractUrls(text)) {
      // The gate is `isProfileLikeUrl` — profile-shaped on ANY host, not just
      // ours — because that is what the write boundary spends its slots on. A
      // narrower gate here would let eight foreign profile links through
      // unbudgeted and then announce the one person the post does NOT end up
      // mentioning, since the fold would have spent the whole ceiling on the
      // eight it can resolve and dropped ours.
      //
      // No handle is derived here any more: the URL is what the server is asked
      // about, and a handle read out of it on this side would be a second
      // reading of the same characters, free to disagree with the one that
      // actually decides.
      if (!isProfileLikeUrl(url, OWN_PROFILE_HOSTS)) continue;
      // Distinct URLs, matching how the write boundary spends its budget: two
      // spellings of one profile (`/@alice` and `/ap/users/alice`) each cost a
      // lookup there, so they each cost a slot here.
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(url);
      if (links.length >= limit) return links;
    }
  }
  return links;
}
