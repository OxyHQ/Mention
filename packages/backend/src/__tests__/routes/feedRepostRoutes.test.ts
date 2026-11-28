// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import feedRoutes from '../../routes/feed.routes';
import postRoutes from '../../routes/posts';

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

const routesOf = (router: unknown): string[] =>
  ((router as { stack: Layer[] }).stack ?? []).flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods).map(
          (method) => `${method.toUpperCase()} ${layer.route?.path}`,
        )
      : [],
  );

describe('repost routes', () => {
  it('serves the repost routes and still the deprecated boost aliases', () => {
    const feed = routesOf(feedRoutes);
    expect(feed).toContain('POST /repost');
    expect(feed).toContain('DELETE /:postId/repost');
    // Clients shipped before the rename keep working until the aliases are retired.
    expect(feed).toContain('POST /boost');
    expect(feed).toContain('DELETE /:postId/boost');

    const posts = routesOf(postRoutes);
    expect(posts).toContain('GET /:id/reposts');
    expect(posts).toContain('GET /:id/boosts');
  });
});
