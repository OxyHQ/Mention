import type { AvatarIdentitySummary, PostUser } from '@mention/shared-types';

/** Preserve public identity for avatar groups without serializing unrelated profile fields. */
export function avatarIdentitySummary(user: PostUser): AvatarIdentitySummary {
  const { id, username, name, avatar, kind, character, isFederated, instance, federation } = user;
  return { id, username, name, avatar, kind, character, isFederated, instance, federation };
}
