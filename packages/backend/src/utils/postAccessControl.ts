import { PostVisibility } from '@mention/shared-types';

export type ShareTargetPost = {
  status?: string;
  visibility?: string;
  quotesDisabled?: boolean;
};

export type ShareValidationResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

export type ShareValidationOptions = {
  action: 'boost' | 'quote';
};

/**
 * Enforce post-level access before creating a public wrapper around another post.
 *
 * Boosts and quotes are currently always created as public posts. Therefore the
 * target must itself be published and public; otherwise hydration could expose a
 * private, followers-only, draft, or scheduled post through the public wrapper.
 */
export function validatePublicShareTarget(
  targetPost: ShareTargetPost | null | undefined,
  options: ShareValidationOptions,
): ShareValidationResult {
  if (!targetPost) {
    return { ok: false, status: 404, message: 'Post not found' };
  }

  if ((targetPost.status ?? 'published') !== 'published') {
    return { ok: false, status: 403, message: `You cannot ${options.action} this post` };
  }

  if ((targetPost.visibility ?? PostVisibility.PUBLIC) !== PostVisibility.PUBLIC) {
    return { ok: false, status: 403, message: `You cannot ${options.action} this post` };
  }

  if (options.action === 'quote' && targetPost.quotesDisabled) {
    return { ok: false, status: 403, message: 'Quotes are disabled for this post' };
  }

  return { ok: true };
}
