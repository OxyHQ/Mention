import type { PostUser } from '@mention/shared-types';

export type DegradedActorSummary = PostUser & {
  username: string;
  name: { displayName: string };
  avatar: null;
};

/**
 * Canonical unresolved-user placeholder.
 *
 * The raw Oxy id remains available only as the DTO identifier. Visual identity
 * fields deliberately contain no id-derived handle, so clients cannot render a
 * transient lookup failure as a real account.
 */
export function degradedActorSummary(userId: string): DegradedActorSummary {
  return {
    id: userId,
    username: '',
    name: { displayName: 'Unknown user' },
    avatar: null,
  };
}
