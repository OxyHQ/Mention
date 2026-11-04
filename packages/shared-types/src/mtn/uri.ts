/**
 * The stable identifier of a Mention post: `mtn://<oxyUserId>/app.mention.feed.post/<postId>`.
 *
 * Threadgates and postgates are keyed by it (`post_uri`, unique), so the format
 * is frozen: it outlived the signed-record chain it was first minted for.
 */
const MENTION_POST_COLLECTION = 'app.mention.feed.post' as const;

export function createPostUri(oxyUserId: string, postId: string): string {
  return `mtn://${oxyUserId}/${MENTION_POST_COLLECTION}/${postId}`;
}
