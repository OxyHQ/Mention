export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

export type GranularReplyPermission = 'followers' | 'following' | 'mentioned';

export const GRANULAR_REPLY_OPTIONS: { value: GranularReplyPermission; labelKey: string }[] = [
  { value: 'followers', labelKey: 'Your followers' },
  { value: 'following', labelKey: 'People you follow' },
  { value: 'mentioned', labelKey: 'People you mention' },
];

/**
 * The permissions after toggling one granular audience. Emptying the set falls
 * back to 'anyone', so a post is never left with no one who may reply by accident.
 */
export function toggleGranularPermission(
  current: readonly ReplyPermission[],
  value: GranularReplyPermission,
): ReplyPermission[] {
  const granular = current.filter(
    (p): p is GranularReplyPermission =>
      p === 'followers' || p === 'following' || p === 'mentioned',
  );
  const next = granular.includes(value)
    ? granular.filter((p) => p !== value)
    : [...granular, value];
  return next.length === 0 ? ['anyone'] : next;
}
