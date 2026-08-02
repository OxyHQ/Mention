import type { PostAuthorshipEntry } from '@mention/shared-types';
import {
  loadPostRecord,
  replacePostAuthorship,
  updatePostRecord,
} from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { createNotification } from '../utils/notificationUtils';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { postHydrationService } from './PostHydrationService';
import { logger } from '../utils/logger';
import { getRuntimeSocketServer } from '../runtime/socketServer';
import {
  buildAuthorship,
  buildCollaboratorEntry,
  getOwner,
  getOwnerId,
  getPendingCollaborators,
  getViewerEntry,
  hasCollaborators,
  hasPendingCollabInvites,
  normalizeAuthorship,
  validateCollaboratorIds,
} from '../utils/postAuthorship';
import { getPostFederator } from './serviceRegistry';
import { resolveLocalMentionHandles } from '../utils/resolveLocalMentionHandles';

export class CollabValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollabValidationError';
  }
}

export class CollabStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollabStateError';
  }
}

class PostCollaborationService {
  async resolveCollaboratorRefs(
    ownerId: string,
    collaboratorIds?: string[],
    collaboratorHandles?: string[],
  ): Promise<string[] | undefined> {
    const ids = (collaboratorIds ?? []).filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    );

    const handles = (collaboratorHandles ?? []).filter(
      (handle): handle is string => typeof handle === 'string' && handle.trim().length > 0,
    );

    if (ids.length === 0 && handles.length === 0) {
      return undefined;
    }

    let resolvedFromHandles: string[] = [];
    if (handles.length > 0) {
      try {
        const users = await resolveLocalMentionHandles(handles);
        resolvedFromHandles = users.map((user) => user.oxyUserId);
      } catch (err) {
        throw new CollabValidationError(err instanceof Error ? err.message : 'Invalid collaborators');
      }
    }

    const merged = Array.from(new Set([...ids, ...resolvedFromHandles]));
    if (merged.length === 0) {
      return undefined;
    }

    return this.validateInvites(ownerId, merged);
  }

  async validateInvites(ownerId: string, collaboratorIds: string[]): Promise<string[]> {
    let uniqueIds: string[];
    try {
      uniqueIds = validateCollaboratorIds(ownerId, collaboratorIds);
    } catch (err) {
      throw new CollabValidationError(err instanceof Error ? err.message : 'Invalid collaborators');
    }
    if (uniqueIds.length === 0) return [];

    const oxy = getServiceOxyClient();
    const users = await oxy.getUsersByIds(uniqueIds);
    const foundIds = new Set(users.map((u) => u.id));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new CollabValidationError(`Unknown users: ${missing.join(', ')}`);
    }

    const federated = users.filter((u) => u.type === 'federated');
    if (federated.length > 0) {
      throw new CollabValidationError('Federated users cannot be collaborators');
    }

    return uniqueIds;
  }

  buildAuthorship(ownerId: string, collaboratorIds: string[]): PostAuthorshipEntry[] {
    return buildAuthorship(ownerId, collaboratorIds);
  }

  /**
   * Attach collaborator invites to an existing solo post (edit-within-window flow).
   *
   * Persists the new authorship itself rather than handing the caller a mutated
   * object to save: `post_authorships` allows exactly one `owner` row, so the
   * only correct write is the transactional delete-then-insert in
   * {@link replacePostAuthorship} — a caller assembling its own update would
   * either violate that index or silently write the list twice.
   */
  async attachCollaborators(
    post: PostRecord,
    ownerId: string,
    collaboratorIds: string[],
  ): Promise<PostRecord> {
    if (collaboratorIds.length === 0) return post;

    const authorship = normalizeAuthorship(post.authorship);
    if (hasCollaborators(authorship)) {
      throw new CollabStateError('This post already has collaborators');
    }

    const owner = getOwner(authorship);
    if (!owner || owner.oxyUserId !== ownerId) {
      throw new CollabStateError('Only the post owner can invite collaborators');
    }

    if (post.federation != null) {
      throw new CollabValidationError('Collaborators cannot be added to federated posts');
    }

    if (post.parentPostId || post.boostOf) {
      throw new CollabValidationError('Only top-level posts can have collaborators');
    }

    const updated = [...authorship, ...collaboratorIds.map((id) => buildCollaboratorEntry(id))];
    await replacePostAuthorship(post.id, updated);

    // Solo posts federate immediately at creation. Converting them to collab via
    // edit must not schedule a second delivery when invites resolve.
    if (post.metadata.federationDelivered) {
      return { ...post, authorship: updated };
    }
    await updatePostRecord(post.id, { metadata: { collabFederationDeferred: true } });
    return {
      ...post,
      authorship: updated,
      metadata: { ...post.metadata, collabFederationDeferred: true },
    };
  }

  async notifyPendingInvites(post: PostRecord, ownerId: string): Promise<void> {
    const pending = getPendingCollaborators(post.authorship);
    if (pending.length === 0) return;

    await Promise.allSettled(
      pending.map((entry) =>
        createNotification({
          recipientId: entry.oxyUserId,
          actorId: ownerId,
          type: 'collab_invite',
          entityId: post.id,
          entityType: 'post',
        }),
      ),
    );
  }

  /**
   * Accept pending collaborator invites for users in `userIds` (e.g. linked MCP
   * bundle accounts). One save, owner notifications per accept, then deferred
   * federation if every invite is resolved.
   */
  async autoAcceptInvites(post: PostRecord, userIds: ReadonlySet<string>): Promise<PostRecord> {
    if (userIds.size === 0) return post;

    const authorship = normalizeAuthorship(post.authorship);
    const ownerId = getOwnerId(authorship);
    let changed = false;
    const notificationsToSend: Array<{ recipientId: string; actorId: string }> = [];

    for (const entry of authorship) {
      if (entry.role !== 'collaborator' || entry.status !== 'pending') continue;
      if (!userIds.has(entry.oxyUserId)) continue;

      entry.status = 'accepted';
      entry.respondedAt = new Date().toISOString();
      changed = true;

      if (ownerId && ownerId !== entry.oxyUserId) {
        notificationsToSend.push({
          recipientId: ownerId,
          actorId: entry.oxyUserId,
        });
      }
    }

    if (!changed) return post;

    await replacePostAuthorship(post.id, authorship);
    const accepted: PostRecord = { ...post, authorship };

    if (notificationsToSend.length > 0) {
      await Promise.allSettled(
        notificationsToSend.map(({ recipientId, actorId }) =>
          createNotification({
            recipientId,
            actorId,
            type: 'collab_accepted',
            entityId: post.id,
            entityType: 'post',
          }),
        ),
      );
    }

    await this.emitPostUpdate(accepted);
    return this.maybeFederateOnResolve(accepted);
  }

  private async loadPost(postId: string): Promise<PostRecord> {
    const post = await loadPostRecord(postId);
    if (!post) {
      throw new CollabStateError('Post not found');
    }
    return post;
  }

  /**
   * Deliver the DEFERRED federation for a collaborative post once every invite
   * has resolved. Collaborative posts skip federation at creation (an invitee
   * must never be leaked to the fediverse before consenting), so the fan-out is
   * triggered here the moment the LAST pending invite is accepted or declined.
   *
   * Only local (`federation == null`), published posts fan out, and only when
   * NO invite is still pending. The owner's username is resolved from Oxy to
   * build the actor. Best-effort and fully isolated — a federation failure never
   * fails the accept/decline response.
   */
  private async maybeFederateOnResolve(post: PostRecord): Promise<PostRecord> {
    if (post.federation != null) return post;
    if (post.status !== 'published') return post;
    if (hasPendingCollabInvites(post.authorship)) return post;
    if (!post.metadata.collabFederationDeferred) return post;

    const ownerId = getOwnerId(post.authorship);
    if (!ownerId) return post;

    try {
      const owner = await getServiceOxyClient().getUserById(ownerId);
      if (!owner.username) return post;
      await getPostFederator().federateNewPost(post, ownerId, owner.username);
      await updatePostRecord(post.id, {
        metadata: { federationDelivered: true, collabFederationDeferred: false },
      });
      return {
        ...post,
        metadata: { ...post.metadata, federationDelivered: true, collabFederationDeferred: false },
      };
    } catch (error) {
      logger.warn('PostCollaborationService: deferred federation on invite resolve failed', { error });
      return post;
    }
  }

  private async emitPostUpdate(post: PostRecord): Promise<void> {
    try {
      const io = getRuntimeSocketServer();
      if (!io) return;
      const [hydratedPost] = await postHydrationService.hydratePosts([post], {
        viewerId: undefined,
        oxyClient: getServiceOxyClient(),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      if (hydratedPost) {
        io.emit('feed:updated', {
          type: 'for_you',
          post: hydratedPost,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn('PostCollaborationService: feed:updated emit failed', { error: err });
    }
  }

  /**
   * Flip ONE collaborator entry's status and persist the whole list.
   *
   * The three viewer-driven transitions (accept / decline / stop sharing) differ
   * only in the status they write and the notification they send, so they share
   * this body — three near-identical copies of a delete-then-insert authorship
   * write is how one of them ends up missing the `respondedAt` stamp.
   */
  private async transitionViewerEntry(
    postId: string,
    userId: string,
    from: PostAuthorshipEntry['status'],
    to: PostAuthorshipEntry['status'],
    notFoundMessage: string,
  ): Promise<PostRecord> {
    const post = await this.loadPost(postId);
    const authorship = normalizeAuthorship(post.authorship);
    const entry = getViewerEntry(authorship, userId);
    if (!entry || entry.role !== 'collaborator' || entry.status !== from) {
      throw new CollabStateError(notFoundMessage);
    }

    entry.status = to;
    entry.respondedAt = new Date().toISOString();
    await replacePostAuthorship(post.id, authorship);
    return { ...post, authorship };
  }

  async accept(postId: string, userId: string): Promise<PostRecord> {
    const post = await this.transitionViewerEntry(
      postId,
      userId,
      'pending',
      'accepted',
      'No pending collaboration invite for this post',
    );

    const ownerId = getOwnerId(post.authorship);
    if (ownerId && ownerId !== userId) {
      await createNotification({
        recipientId: ownerId,
        actorId: userId,
        type: 'collab_accepted',
        entityId: post.id,
        entityType: 'post',
      });
    }

    await this.emitPostUpdate(post);
    // The accept may have resolved the LAST pending invite — deliver the deferred
    // federation now that every collaborator has consented.
    return this.maybeFederateOnResolve(post);
  }

  async decline(postId: string, userId: string): Promise<PostRecord> {
    const post = await this.transitionViewerEntry(
      postId,
      userId,
      'pending',
      'declined',
      'No pending collaboration invite for this post',
    );

    const ownerId = getOwnerId(post.authorship);
    if (ownerId && ownerId !== userId) {
      await createNotification({
        recipientId: ownerId,
        actorId: userId,
        type: 'collab_declined',
        entityId: post.id,
        entityType: 'post',
      });
    }

    await this.emitPostUpdate(post);
    // A decline can also resolve the last pending invite — the post is still a
    // valid owner post and must not stay stuck un-federated, so trigger the
    // deferred federation once no invite remains pending.
    return this.maybeFederateOnResolve(post);
  }

  async stopSharing(postId: string, userId: string): Promise<PostRecord> {
    const post = await this.transitionViewerEntry(
      postId,
      userId,
      'accepted',
      'stopped',
      'You are not an active collaborator on this post',
    );
    await this.emitPostUpdate(post);
    return post;
  }

  getOwnerEntry(post: PostRecord): PostAuthorshipEntry | undefined {
    return getOwner(post.authorship);
  }
}

export const postCollaborationService = new PostCollaborationService();
