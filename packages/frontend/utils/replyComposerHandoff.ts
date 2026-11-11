import { createDraftId } from './draftSession';
import type { ComposerMediaItem } from './composeUtils';

export interface ReplyComposerHandoffScope {
  viewerId: string;
  epoch: number;
  replyToPostId: string;
}

interface ReplyComposerHandoffInput extends ReplyComposerHandoffScope {
  /** Stable originating route/host identity; independent Deck columns must differ. */
  sourceId: string;
  text: string;
  /** Already staged file IDs, including GIF picker MP4 IDs; never temporary preview URLs. */
  mediaIds?: readonly ComposerMediaItem[];
  revision: number;
  pending?: boolean;
  /** The source clears only its unchanged revision after the receiver accepts the text. */
  onClaim?: () => void;
}

const MAX_OUTSTANDING_HANDOFFS = 32;
const handoffs = new Map<string, ReplyComposerHandoffInput>();

function matches(entry: ReplyComposerHandoffScope, scope: ReplyComposerHandoffScope) {
  return (
    entry.viewerId === scope.viewerId &&
    entry.epoch === scope.epoch &&
    entry.replyToPostId === scope.replyToPostId
  );
}

/** Internal, transient draft transfer. Public URL text parsing remains unchanged. */
export function createReplyComposerHandoff(input: ReplyComposerHandoffInput): string | undefined {
  if (!input.viewerId || !input.replyToPostId || !input.sourceId || input.pending) return undefined;
  for (const [token, entry] of handoffs) {
    if (
      entry.viewerId === input.viewerId &&
      entry.epoch === input.epoch &&
      entry.sourceId === input.sourceId
    )
      handoffs.delete(token);
  }
  while (handoffs.size >= MAX_OUTSTANDING_HANDOFFS) {
    const oldest = handoffs.keys().next().value;
    if (oldest !== undefined) handoffs.delete(oldest);
  }
  const token = createDraftId();
  handoffs.set(token, { ...input, mediaIds: input.mediaIds?.map((media) => ({ ...media })) });
  return token;
}

/**
 * Claim once from the modal's committed lifecycle, never during render. The
 * caller supplies the current projected viewer/epoch; this is not API authority.
 * Apply the exact text to the editor before acknowledging its receipt. After
 * claiming, only that editor holds the acknowledgement; no global callback remains.
 */
export function consumeReplyComposerHandoff(token: string, scope: ReplyComposerHandoffScope) {
  const entry = handoffs.get(token);
  if (!entry || !matches(entry, scope)) return undefined;
  handoffs.delete(token);
  const expectedScope = {
    viewerId: entry.viewerId,
    epoch: entry.epoch,
    replyToPostId: entry.replyToPostId,
  };
  let onClaim = entry.onClaim;
  let acknowledged = false;
  return {
    text: entry.text,
    mediaIds: entry.mediaIds?.map((media) => ({ ...media })) ?? [],
    revision: entry.revision,
    sourceId: entry.sourceId,
    replyToPostId: entry.replyToPostId,
    acknowledge(currentScope: ReplyComposerHandoffScope): boolean {
      if (acknowledged || !matches(expectedScope, currentScope)) return false;
      acknowledged = true;
      const notify = onClaim;
      onClaim = undefined;
      notify?.();
      return true;
    },
  };
}

/** Cancel failed navigation without clearing the source draft. */
export function discardReplyComposerHandoff(token: string, scope: ReplyComposerHandoffScope) {
  const entry = handoffs.get(token);
  if (!entry || !matches(entry, scope)) return false;
  return handoffs.delete(token);
}
