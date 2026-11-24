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
