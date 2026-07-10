import type { PostAuthorshipEntry } from '@mention/shared-types';
import { Post, IPost } from '../models/Post';
import { createNotification } from '../utils/notificationUtils';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { postHydrationService } from './PostHydrationService';
import { logger } from '../utils/logger';
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
   * Mutates `post.authorship` in memory — the caller persists via `post.save()`.
   */
  async attachCollaborators(post: IPost, ownerId: string, collaboratorIds: string[]): Promise<void> {
    if (collaboratorIds.length === 0) return;

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

    post.authorship = [...authorship, ...collaboratorIds.map((id) => buildCollaboratorEntry(id))];
    post.markModified('authorship');

    const meta = (post.metadata ?? {}) as Record<string, unknown>;
    // Solo posts federate immediately at creation. Converting them to collab via
    // edit must not schedule a second delivery when invites resolve.
    if (!meta.federationDelivered) {
      post.metadata = { ...meta, collabFederationDeferred: true };
      post.markModified('metadata');
    }
  }

  async notifyPendingInvites(post: IPost, ownerId: string): Promise<void> {
    const pending = getPendingCollaborators(post.authorship ?? []);
    if (pending.length === 0) return;

    await Promise.allSettled(
      pending.map((entry) =>
        createNotification({
          recipientId: entry.oxyUserId,
          actorId: ownerId,
          type: 'collab_invite',
          entityId: String(post._id),
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
  async autoAcceptInvites(post: IPost, userIds: ReadonlySet<string>): Promise<IPost> {
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

    post.authorship = authorship;
    post.markModified('authorship');
    await post.save();

    if (notificationsToSend.length > 0) {
      await Promise.allSettled(
        notificationsToSend.map(({ recipientId, actorId }) =>
          createNotification({
            recipientId,
            actorId,
            type: 'collab_accepted',
            entityId: String(post._id),
            entityType: 'post',
          }),
        ),
      );
    }

    await this.emitPostUpdate(post);
    await this.maybeFederateOnResolve(post);
    return post;
  }

  private async loadPost(postId: string): Promise<IPost> {
    const post = await Post.findById(postId);
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
  private async maybeFederateOnResolve(post: IPost): Promise<void> {
    if (post.federation != null) return;
    if ((post.status ?? 'published') !== 'published') return;
    if (hasPendingCollabInvites(post.authorship ?? [])) return;

    const meta = (post.metadata ?? {}) as Record<string, unknown>;
    if (!meta.collabFederationDeferred) return;

    const ownerId = getOwnerId(post.authorship ?? []);
    if (!ownerId) return;

    try {
      const owner = await getServiceOxyClient().getUserById(ownerId);
      if (!owner.username) return;
      await getPostFederator().federateNewPost(post, ownerId, owner.username);
      post.metadata = { ...(post.metadata ?? {}), federationDelivered: true, collabFederationDeferred: false };
      post.markModified('metadata');
      await post.save();
    } catch (error) {
      logger.warn('PostCollaborationService: deferred federation on invite resolve failed', { error });
    }
  }

  private async emitPostUpdate(post: IPost): Promise<void> {
    try {
      const io = global.io;
      if (!io) return;
      const [hydratedPost] = await postHydrationService.hydratePosts([post.toObject()], {
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

  async accept(postId: string, userId: string): Promise<IPost> {
    const post = await this.loadPost(postId);
    const entry = getViewerEntry(post.authorship ?? [], userId);
    if (!entry || entry.role !== 'collaborator' || entry.status !== 'pending') {
      throw new CollabStateError('No pending collaboration invite for this post');
    }

    entry.status = 'accepted';
    entry.respondedAt = new Date().toISOString();
    await post.save();

    const ownerId = getOwnerId(post.authorship ?? []);
    if (ownerId && ownerId !== userId) {
      await createNotification({
        recipientId: ownerId,
        actorId: userId,
        type: 'collab_accepted',
        entityId: String(post._id),
        entityType: 'post',
      });
    }

    await this.emitPostUpdate(post);
    // The accept may have resolved the LAST pending invite — deliver the deferred
    // federation now that every collaborator has consented.
    await this.maybeFederateOnResolve(post);
    return post;
  }

  async decline(postId: string, userId: string): Promise<IPost> {
    const post = await this.loadPost(postId);
    const entry = getViewerEntry(post.authorship ?? [], userId);
    if (!entry || entry.role !== 'collaborator' || entry.status !== 'pending') {
      throw new CollabStateError('No pending collaboration invite for this post');
    }

    entry.status = 'declined';
    entry.respondedAt = new Date().toISOString();
    await post.save();

    const ownerId = getOwnerId(post.authorship ?? []);
    if (ownerId && ownerId !== userId) {
      await createNotification({
        recipientId: ownerId,
        actorId: userId,
        type: 'collab_declined',
        entityId: String(post._id),
        entityType: 'post',
      });
    }

    await this.emitPostUpdate(post);
    // A decline can also resolve the last pending invite — the post is still a
    // valid owner post and must not stay stuck un-federated, so trigger the
    // deferred federation once no invite remains pending.
    await this.maybeFederateOnResolve(post);
    return post;
  }

  async stopSharing(postId: string, userId: string): Promise<IPost> {
    const post = await this.loadPost(postId);
    const entry = getViewerEntry(post.authorship ?? [], userId);
    if (!entry || entry.role !== 'collaborator' || entry.status !== 'accepted') {
      throw new CollabStateError('You are not an active collaborator on this post');
    }

    entry.status = 'stopped';
    entry.respondedAt = new Date().toISOString();
    await post.save();
    await this.emitPostUpdate(post);
    return post;
  }

  getOwnerEntry(post: IPost): PostAuthorshipEntry | undefined {
    return getOwner(post.authorship ?? []);
  }
}

export const postCollaborationService = new PostCollaborationService();
