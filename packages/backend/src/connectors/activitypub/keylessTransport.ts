import { subscribedSinceForAccount } from '../../db/federation/importProvenanceRepository';
import { keyedMirrorHosts, keylessMirrorNetwork } from '../../utils/federation/mirrorTransports';
import { getRemoteHost } from '../shared/url';

/**
 * A KEYLESS TRANSPORT FILLS HISTORY; IT NEVER RUNS ALONGSIDE A KEYED ONE.
 *
 * mastox.eu copies X accounts as a stock Mastodon. Its status ids are its own,
 * its posts name no tweet (no id, no x.com link, no card), and its `published`
 * is when it crawled the tweet, not when the tweet was written. bird.makeup
 * carries the same accounts with the tweet id as the status id. So a tweet that
 * reaches Mention through both is two objects, and nothing proves they are one.
 *
 * Content matching cannot prove it either. Measured in production (2026-11-04)
 * on the accounts held through both bridges:
 *
 *  - the same account posts the same text several times within an hour (three
 *    mastox copies of one sentence, 16:16, 16:37 and 17:38, around one 17:35
 *    tweet; a tweet deleted and re-posted two minutes later);
 *  - mastox drops media: 5% of its posts carry any, against 34% of bird.makeup's,
 *    so "same media count" refuses most real pairs;
 *  - its crawl lag is unknown and unbounded, so a time window is a guess.
 *
 * A wrong merge would hang one post's replies, likes and boosts on another
 * post; a missed one leaves a duplicate card. Neither is acceptable, so the two
 * are never compared. Instead their TIME is split: once an account's keyed
 * transport delivers by subscription, the keyless one stops being a source for
 * anything at or after that moment. Before it, the keyless transport is the only
 * thing that ever delivered those posts — bird.makeup has no outbox — so its
 * history is kept, and is the only way that history exists here.
 *
 * The moment is the publication time of the first post Mention stored from a
 * keyed transport of the same account (Oxy's `canonicalAcct`, cached as
 * `network_acct`) BECAUSE it follows it (`subscribedSinceForAccount`). A keyed
 * post fetched as a quote or a reply parent does not move it. Until that first
 * delivery the keyless transport stays live, so an account whose keyed bridge
 * never delivers is never silenced.
 *
 * What this costs: the few tweets the keyless transport stored between the keyed
 * follow and the keyed transport's first delivery can be stored twice, once per
 * transport. And once the keyed transport has delivered, the keyless one is
 * history-only even after everyone unfollows: new posts then arrive only when
 * someone follows the account again.
 */
export async function keylessTransportRefusal(
  author: { uri: string; domain?: string | null; networkAcct?: string | null },
  published: Date | undefined,
): Promise<string | null> {
  const network = keylessMirrorNetwork(author.domain ?? getRemoteHost(author.uri) ?? '');
  if (!network || !author.networkAcct) return null;
  const since = await subscribedSinceForAccount(author.networkAcct, keyedMirrorHosts(network));
  if (!since || (published && published < since)) return null;
  return 'keyless-after-keyed-subscription';
}
