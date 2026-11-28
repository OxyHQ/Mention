import { useRef, useState } from 'react';

/**
 * Whether the viewer just followed THIS account, in this visit.
 *
 * Distinguishes a follow the viewer performed from a follow they already had,
 * which is what lets the profile offer suggestions on the ACTION without
 * ambushing every revisit to an account they have followed for a year.
 *
 * The transition is computed during render rather than in an effect, because an
 * effect chain here would fire once on hydration — the follow store seeds
 * asynchronously — and read that seed as a follow the viewer just performed.
 * The three refs are what tell the three cases apart: a different account, the
 * first settled value for this one, and a real change afterwards.
 *
 * Shared by both profile screens. The rule has nothing to do with what kind of
 * account is being followed, and it is subtle enough that a second copy would be
 * a second chance to get the hydration case wrong.
 */
export function useJustFollowed(userId: string, isFollowing: boolean): boolean {
  const [justFollowed, setJustFollowed] = useState(false);
  const settledRef = useRef(false);
  const prevFollowRef = useRef(isFollowing);
  const prevUserIdRef = useRef(userId);

  if (prevUserIdRef.current !== userId) {
    // Navigated to a different account: nothing carries over.
    prevUserIdRef.current = userId;
    settledRef.current = false;
    prevFollowRef.current = false;
    if (justFollowed) setJustFollowed(false);
  } else if (!settledRef.current) {
    // First settled value for this account — store hydration, not an action.
    settledRef.current = true;
    prevFollowRef.current = isFollowing;
  } else if (isFollowing !== prevFollowRef.current) {
    if (isFollowing) {
      setJustFollowed(true);
    } else if (justFollowed) {
      setJustFollowed(false);
    }
    prevFollowRef.current = isFollowing;
  }

  return justFollowed;
}
