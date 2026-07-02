import { describe, it, expect } from 'vitest';
import { Post } from '../models/Post';

/**
 * The top-level `post.language` (ActivityPub protocol field) must reflect the
 * REAL primary language of the post — the classifier's `languages[0]`, or nothing
 * when no language could be declared/detected. It must NOT be silently defaulted
 * to `'en'`, which mislabels every language-less/undetectable post as English and
 * poisons language-based feed filtering + recommendation.
 *
 * These instantiate real Post documents (no DB) and assert the schema default.
 */
describe('Post.language default', () => {
  it('is undefined (not "en") when no language is provided', () => {
    const doc = new Post({ content: { text: 'hi' } });
    expect(doc.language).toBeUndefined();
  });

  it('keeps an explicitly set language', () => {
    const doc = new Post({ content: { text: 'hola' }, language: 'es' });
    expect(doc.language).toBe('es');
  });
});
