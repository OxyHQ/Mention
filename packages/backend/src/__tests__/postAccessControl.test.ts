import { describe, expect, it } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import { validatePublicShareTarget } from '../utils/postAccessControl';

describe('validatePublicShareTarget', () => {
  it('rejects missing targets', () => {
    const result = validatePublicShareTarget(null, { action: 'boost' });
    expect(result).toEqual({ ok: false, status: 404, message: 'Post not found' });
  });

  it('rejects unpublished targets', () => {
    const result = validatePublicShareTarget(
      { status: 'draft', visibility: PostVisibility.PUBLIC },
      { action: 'quote' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects private targets', () => {
    const result = validatePublicShareTarget(
      { status: 'published', visibility: PostVisibility.PRIVATE },
      { action: 'boost' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects followers-only targets', () => {
    const result = validatePublicShareTarget(
      { status: 'published', visibility: PostVisibility.FOLLOWERS_ONLY },
      { action: 'quote' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects quote targets with quotes disabled', () => {
    const result = validatePublicShareTarget(
      { status: 'published', visibility: PostVisibility.PUBLIC, quotesDisabled: true },
      { action: 'quote' },
    );
    expect(result).toEqual({ ok: false, status: 403, message: 'Quotes are disabled for this post' });
  });

  it('allows published public targets', () => {
    const result = validatePublicShareTarget(
      { status: 'published', visibility: PostVisibility.PUBLIC },
      { action: 'boost' },
    );
    expect(result).toEqual({ ok: true });
  });
});
