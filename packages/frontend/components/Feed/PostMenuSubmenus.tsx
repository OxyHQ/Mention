/**
 * What the ⋯ menu's submenus do (`PostMenu` draws their rows): a source's
 * label, saving a post's reply settings, and moving it between lanes.
 */
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import type { HydratedPost, PostSourceLink } from '@mention/shared-types';
import { lanesService } from '@/services/lanesService';
import { savePostSettings, type PostSettingsPatch } from './postSettings';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { usePostsStore } from '@/stores/postsStore';

const logger = createLogger('PostMenuSubmenus');

/** The radio value of "no lane"; no lane id can collide with it. */
export const NO_LANE = '';

/** A source row reads as its title, or as the site it links to. */
export function sourceLabel(source: PostSourceLink): string {
  if (source.title?.trim()) return source.title.trim();
  try {
    return new URL(source.url).hostname.replace(/^www\./, '');
  } catch {
    return source.url;
  }
}

/** Saves one of a post's settings; a refused write is put back by the store and told. */
export async function changePostSetting(
  postId: string,
  patch: PostSettingsPatch,
  failureMessage: string,
): Promise<void> {
  if (!(await savePostSettings(postId, patch))) toast(failureMessage, { type: 'error' });
}

/** Moves a post to a lane (`NO_LANE`: out of any), and tells every list that shows it. */
export async function movePostToLane(
  post: HydratedPost,
  value: string,
  failureMessage: string,
): Promise<void> {
  const laneId = value === NO_LANE ? null : value;
  try {
    const lane = await lanesService.setPostLane(post.id, laneId);
    usePostsStore.getState().updatePostEverywhere(post.id, (prev) => ({
      ...prev,
      lane: lane ?? undefined,
    }));
    // The chip flips instantly through the store above; WHICH profile tab the
    // post now sits on is server-ordered and paged, so both post-list caches
    // have to be told.
    noteLaneListsChanged('assignment');
  } catch (error) {
    logger.error('Failed to move post to lane', error);
    toast(failureMessage, { type: 'error' });
  }
}
