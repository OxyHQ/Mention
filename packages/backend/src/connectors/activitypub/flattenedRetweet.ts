/**
 * A retweet a bridge FLATTENED into an ordinary post, which we cannot render as
 * the repost it is.
 *
 * bird.makeup and mastox do not emit an ActivityPub `Announce`. They publish a
 * plain Note, authored by the RETWEETER, whose body opens `RT: @original` — and
 * the object carries nothing else: `inReplyTo` is null, `tag` is empty, there is
 * no `quoteUrl`, no link to the upstream post, no id of any kind. Verified field
 * by field against live notes from both.
 *
 * So the post appears under the wrong byline: Pablo Iglesias signing text Julio
 * wrote, with no way to reach the original. Until we can show the original post
 * — which needs a reference the bridge does not currently give us — these are
 * dropped rather than published under a name that did not write them.
 *
 * THIS IS TEMPORARY, AND IT IS THE ONLY PLACE THAT READS THE BODY TO DECIDE
 * SOMETHING. It is here rather than in the identity path on purpose, because the
 * two directions of failure are not alike: a MISSED retweet stores exactly what
 * we store today, while a FALSE match discards a real post. Hence the rule is as
 * narrow as the evidence allows — anchored at position 0, `RT:` then `@` — and
 * it is applied only to actors on a REVIEWED bridge, so an ordinary fediverse
 * user opening a post with "RT:" is never touched.
 *
 * Measured across every sample available when written: 10 of 10 bridge retweets
 * used exactly `RT: @` (8 live from mastox's outbox, 2 stored, one of them from
 * bird.makeup). No other prefix was observed on either bridge.
 */
export function isBridgeFlattenedRetweet(text: string): boolean {
  return /^RT:\s?@/.test(text);
}
