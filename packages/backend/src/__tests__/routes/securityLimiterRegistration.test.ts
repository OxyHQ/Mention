// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

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
    // Either quote style, so formatting cannot decide the verdict.
    const firstSearchHandler = searchSource.search(/router\.get\(\s*['"]\/['"]/);
    expect(firstSearchHandler).toBeGreaterThan(-1);
    expect(searchSource.indexOf('router.use(searchRateLimiter)')).toBeGreaterThan(-1);
    expect(searchSource.indexOf('router.use(searchRateLimiter)')).toBeLessThan(firstSearchHandler);
  });

  it('bounds public profile resolutions before attacker-controlled cache keys are read', () => {
    const webShellSource = source('routes/webShell.routes.ts');

    expect(webShellSource).toContain(
      "namedRoutePattern(/^\\/@([^/]+)(?:\\/.*)?$/, '/@:handle'),\n  webShellRateLimiter,",
    );
    expect(webShellSource).toContain(
      "namedRoutePattern(/^\\/c\\/([^/]+)\\/?$/, '/c/:handle'),\n  webShellRateLimiter,",
    );
  });
});
