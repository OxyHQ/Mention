/**
 * Whether a post's author may be shown on Mention's public web pages: the
 * decision `/p/<id>` makes for every author it renders, and the one the edge
 * purge re-asks after an account changes (`authorPostPagePurge.ts`) to decide
 * whether that author's cached post pages must leave Cloudflare's edge.
 *
 * Moved out of `routes/webShell.routes.ts` unchanged so both read one answer:
 * a background job that decided "still public" by a different rule than the
 * page would leave a hidden author's pages cached for the full edge TTL.
 */
import type { OxyProfileData } from './webShellRenderer';
import { mget as mgetUserSummaries } from '../accounts/userSummaryCache';
import { cachedOxyAuthorVisibility } from '../accounts/oxyAuthorVisibilityCache';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { lookupOxyUsers } from '../../utils/oxyUserLookup';
import { logger } from '../../utils/logger';
import { mentionProfileSeoPolicy, type MentionProfileSeoPolicy } from './seoSitemap';

/** Wall-clock budget for the per-request profile read (sent once, never retried). */
const OG_FETCH_TIMEOUT_MS = 2500;

/**
 * A profile from Oxy, or null when Oxy says no such handle exists. Any other
 * failure throws.
 *
 * The RAW payload rather than the mapped OG, because two callers read it: the OG
 * card, and the channel redirect below — which a BROWSER needs too, so it cannot
 * ride on the crawler-only OG path. One fetch, one cache entry, both answers.
 *
 * As Mention, not anonymously: the process `OxyServer` sends a session-less read
 * with its service token (`serviceIdentity: 'when-anonymous'`). Every web page
 * for a post or profile reads this, and anonymous calls share Oxy's per-IP
 * general limit (1000 per 15 minutes) across every Mention task behind the same
 * egress address: ~9,800 shell 503s a day ("Oxy profile lookup failed (429)",
 * production 2026-10-11/12). A first-party service token is limited per
 * application. Uncached in the SDK: `getShellCached` is this read's cache.
 */
export async function fetchProfile(handle: string): Promise<OxyProfileData | null> {
  try {
    return await getServiceOxyClient()
      .withCallOptions({ deadline: OG_FETCH_TIMEOUT_MS, retry: false })
      .users.byUsername(handle, { cache: false });
  } catch (error) {
    // A 400 is Oxy refusing the handle itself — shorter or longer than any
    // username can be (`usernameParams`, `MIN/MAX_USERNAME_LENGTH`). It names no
    // profile and never will, so it is a 404 page like any other unknown handle,
    // cached negatively like one. Treating it as an outage made it a 503 that
    // invited the crawler back: 19 of the 74 web-shell 503s on 2026-10-14.
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 404 || status === 400) return null;
    logger.debug('[webShell] Profile fetch failed', error);
    throw error;
  }
}

/**
 * Whether Oxy serves this author's public profile. Read through
 * {@link cachedOxyAuthorVisibility}: a public answer for a minute, a hidden one
 * for five, a failure never, and evicted the moment Oxy broadcasts a change to
 * the account — so a crawler's page views are not each an Oxy round trip.
 */
function isOxyAuthorPublic(oxyUserId: string): Promise<boolean> {
  return cachedOxyAuthorVisibility(oxyUserId, () => askOxyIfAuthorPublic(oxyUserId));
}

/**
 * Ask Oxy whether it serves this author's public profile: the profile read is
 * the availability answer.
 *
 * Only the author's HANDLE may come from a cache — the user summary hydration
 * keeps, which this page's card hydration reads for the same author a moment
 * later — and it is trusted only when the profile Oxy returns for it is this
 * very account. A handle that names no one or someone else now (a rename, a
 * merged account) falls back to asking Oxy who the account is, as every
 * request used to. A cached handle saves the serial `users/by-ids` round trip
 * on every crawled post page by an author seen in the last few minutes.
 */
async function askOxyIfAuthorPublic(oxyUserId: string): Promise<boolean> {
  const cachedHandle = (await mgetUserSummaries([oxyUserId])).get(oxyUserId)?.user?.username;
  let asked: { handle: string; found: boolean } | undefined;
  if (cachedHandle) {
    const profile = await fetchProfile(cachedHandle);
    if (profile?.id === oxyUserId) return true;
    asked = { handle: cachedHandle, found: Boolean(profile) };
  }
  const [user] = (await lookupOxyUsers([oxyUserId], 'web_shell.profile')).found;
  if (!user?.username) return false;
  // That handle was already asked about in this request; its answer stands.
  if (asked?.handle === user.username) return asked.found;
  return Boolean(await fetchProfile(user.username));
}

/**
 * Whether a post's author may be shown to anyone — public on Mention AND on Oxy
 * — and whether search engines may index them. The Mention half is read fresh;
 * the Oxy half is {@link isOxyAuthorPublic}'s short, invalidated cache.
 * The two reads are independent, so they run together rather than one
 * round-trip after the other.
 */
export async function authorSeoPolicy(oxyUserId: string): Promise<MentionProfileSeoPolicy> {
  if (!oxyUserId) return { visible: false, indexable: false };
  const [onMention, onOxy] = await Promise.all([
    mentionProfileSeoPolicy(oxyUserId),
    isOxyAuthorPublic(oxyUserId),
  ]);
  return { visible: onMention.visible && onOxy, indexable: onMention.indexable && onOxy };
}
