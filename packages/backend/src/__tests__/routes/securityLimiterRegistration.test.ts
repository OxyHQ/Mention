import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('costly authenticated route rate-limit registration', () => {
  it('bounds owner edit-source reads with the post-view budget', () => {
    expect(source('routes/posts.ts')).toContain(
      "router.get('/:id/edit-source', ...postViewRateLimiters, getPostEditSource)",
    );
  });

  it('mounts the dedicated search budget before any search handler', () => {
    const searchSource = source('routes/search.ts');
    expect(searchSource.indexOf('router.use(searchRateLimiter)')).toBeGreaterThan(-1);
    expect(searchSource.indexOf('router.use(searchRateLimiter)')).toBeLessThan(
      searchSource.indexOf('router.get("/"'),
    );
  });
});
