import React, { memo, useMemo } from 'react';
import { useAuth } from '@oxyhq/services/ui/client';
import { getNormalizedUserHandle, type AccountNode, type User } from '@oxyhq/core';
import type { HydratedAuthor } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import PostHeader from '@/components/Post/PostHeader';
import type { CollaboratorUser } from '@/components/Compose/CollaboratorPicker';
import { AVATAR_SIZE, HPAD } from './composeLayout';

interface ComposeIdentityHeaderProps {
  /**
   * The account this box publishes AS, or `null` for the signed-in person.
   *
   * The header shows WHOSE post this is going to be, so it reads the same value
   * the wire carries — a box whose choice the payload would drop must be passed
   * `null` here too, or the row claims an author the post will not have.
   */
  publishAs: AccountNode | null;
  /**
   * Invited co-authors. With at least one, the header renders the published
   * post's collaborative byline — the avatar cluster and the "A and B" name row
   * — instead of the solo identity line, so the writer sees the byline they are
   * going to get before they publish it.
   */
  collaborators?: CollaboratorUser[];
  /**
   * Tapping the avatar chooses who this box posts as. Omitted where the post
   * cannot carry another author at all (a reply, an edit, a thread), which
   * leaves the avatar inert rather than opening a picker whose answer the
   * payload would discard.
   */
  onPressAvatar?: () => void;
  /** Replaces the relative time in the identity line — the composer's schedule. */
  timeSlot?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * The identity row EVERY compose box carries: avatar, display name, handle, and
 * the body beneath them.
 *
 * One component rather than a full header on the first box and a bare avatar on
 * the rest, because the avatar is now a control — it says who the post is by and
 * opens the picker that changes it. A box drawn without the name and handle
 * shows the control without what it controls, and in beast mode, where each post
 * may go out under a different account, that reduced row is the only disclosure
 * there is.
 *
 * It renders through {@link PostHeader} — the SAME component the published post
 * uses — so a post's byline cannot drift from the composer's preview of it.
 */
const ComposeIdentityHeader = memo(function ComposeIdentityHeader({
  publishAs,
  collaborators,
  onPressAvatar,
  timeSlot,
  children,
}: ComposeIdentityHeaderProps) {
  const { user } = useAuth();

  // Both sides of this are the canonical Oxy `User`: a channel is an account, so
  // publishing as one swaps which user signs the post rather than decorating the
  // author's own row with a second identity.
  const identity: User | null = publishAs?.account ?? user;
  const handle = identity ? getNormalizedUserHandle(identity) ?? '' : '';

  /**
   * Owner + invited collaborators, in byline order, as the published post's own
   * author list. `PostHeader` reduces it to the avatar cluster and the name row
   * itself, so the composer supplies the authors and nothing about how they are
   * drawn. Empty for a solo post — the header then takes its single-author path.
   */
  const authors = useMemo<HydratedAuthor[]>(() => {
    if (!identity || !collaborators || collaborators.length === 0) return [];
    return [
      {
        id: identity.id,
        username: identity.username,
        name: identity.name,
        avatar: identity.avatar,
        verified: Boolean(identity.verified),
        role: 'owner',
        status: 'accepted',
      },
      ...collaborators.map((collaborator): HydratedAuthor => ({
        id: collaborator.id,
        username: collaborator.username,
        name: { displayName: collaborator.displayName },
        avatar: collaborator.avatar,
        role: 'collaborator',
        // What is true while the post is being written: an invite is sent when
        // it publishes, and nobody has answered one yet.
        status: 'pending',
      })),
    ];
  }, [identity, collaborators]);

  return (
    <PostHeader
      paddingHorizontal={HPAD}
      user={{
        displayName: identity?.name?.displayName ?? '',
        handle,
        verified: Boolean(identity?.verified),
      }}
      authors={authors}
      avatarSource={identity?.avatar}
      avatarVariant={MEDIA_VARIANT_AVATAR}
      avatarSize={AVATAR_SIZE}
      onPressAvatar={onPressAvatar}
      // The cluster stands in for the avatar on a collaborative post, so it
      // opens the same picker rather than the published post's author list —
      // there is no post yet to list the authors of.
      onPressCollaborators={onPressAvatar}
      // A card popping over the editor while the author writes in it. The
      // header here previews the post being composed, not a row pointing at
      // somebody else.
      disableHoverCard
      timeSlot={timeSlot}
    >
      {children}
    </PostHeader>
  );
});

export default ComposeIdentityHeader;
