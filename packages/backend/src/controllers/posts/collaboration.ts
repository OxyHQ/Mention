/**
 * The collaborator-invite replies on a post: accept, decline, and the author
 * stopping an accepted collaboration. The state machine itself is
 * `PostCollaborationService`; these are its HTTP edges.
 */

import { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { createScopedOxyClient } from '../../utils/oxyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { postCollaborationService, CollabStateError } from '../../services/PostCollaborationService';

// Accept a collaboration invite
export const acceptCollabInvite = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.accept(String(req.params.id), userId);
    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error accepting collab invite', error);
    return res.status(500).json({ message: 'Error accepting collaboration invite' });
  }
};

export const declineCollabInvite = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.decline(String(req.params.id), userId);
    // Return the fully-hydrated post (same as accept/stop-sharing) so the client
    // can update its cached copy: the viewer's authorship entry is now `declined`,
    // which flips the invite notification from actionable buttons to a resolved
    // state. For a private/followers-only post the decliner loses view access, so
    // hydration yields no post and the client simply drops the actionable UI.
    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error declining collab invite', error);
    return res.status(500).json({ message: 'Error declining collaboration invite' });
  }
};

export const stopCollabSharing = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.stopSharing(String(req.params.id), userId);
    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error stopping collab sharing', error);
    return res.status(500).json({ message: 'Error stopping collaboration sharing' });
  }
};
