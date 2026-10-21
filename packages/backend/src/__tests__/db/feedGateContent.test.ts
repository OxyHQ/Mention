import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb, getPostgresClient } from '../../db/postgres';
import * as schema from '../../db/schema';
import { assembleShellRecords, loadPostGateContent } from '../../db/posts/postRepository';
import {
  lowEffortGateFilter,
  minLengthFilter,
  hasLinkFilter,
  hasAltTextFilter,
  hasImageFilter,
  videoOnlyFilter,
} from '../../mtn/feed/engine/filters';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';

const scope = federationScope('feed-gate-content');
beforeAll(async () => {
  await connectPostgres();
});
afterEach(async () => {
  await clearFederationScope(scope);
});
afterAll(async () => {
  await closePostgres();
});

describe('bounded content evidence for shell gates', () => {
  it('loads cited links and variant alt text only when requested, preserving rendition media', async () => {
    const post = await seedPost(scope, {
      content: {
        media: [{ id: 'gate-alt', type: 'image' }],
        variants: [{ source: 'author', text: '', alt: { 'gate-alt': 'The garden in the rain' } }],
        sources: [{ url: 'https://example.org/evidence', title: 'Evidence' }],
      },
    });
    const video = await seedPost(scope, {
      content: {
        variants: [{ source: 'author', text: '', media: [{ id: 'gate-video', type: 'video' }] }],
      },
    });
    const image = await seedPost(scope, {
      content: {
        variants: [{ source: 'author', text: '', media: [{ id: 'gate-image', type: 'image' }] }],
      },
    });
    const ids = [post.id, video.id, image.id];
    const shells = assembleShellRecords(
      await getDb().select().from(schema.posts).where(inArray(schema.posts.id, ids)),
    );
    const queries: string[] = [];
    const observed = drizzle(getPostgresClient(), {
      schema,
      casing: 'snake_case',
      logger: {
        logQuery: (query) => {
          queries.push(query);
        },
      },
    });
    const content = await loadPostGateContent(ids, observed, { sources: true, variantAlt: true });
    expect(queries).toHaveLength(6);
    const views = shells.map((shell) => ({
      ...shell,
      content: { ...shell.content, ...content.get(shell.id) },
    }));
    expect(
      views.filter((view) => hasLinkFilter.keep?.(view, {}, {})).map((view) => view.id),
    ).toEqual([post.id]);
    expect(
      views.filter((view) => hasAltTextFilter.keep?.(view, {}, {})).map((view) => view.id),
    ).toEqual([post.id]);
    expect(
      views.filter((view) => videoOnlyFilter.keep?.(view, {}, {})).map((view) => view.id),
    ).toEqual([video.id]);
    expect(
      views
        .filter((view) => hasImageFilter.keep?.(view, {}, {}))
        .map((view) => view.id)
        .sort(),
    ).toEqual([post.id, image.id].sort());
    expect(content.get(post.id)?.variants?.[0].alt).toEqual({
      'gate-alt': 'The garden in the rain',
    });
    queries.length = 0;
    await loadPostGateContent(ids, observed, { sources: true });
    expect(queries).toHaveLength(5);
    expect(queries.some((query) => query.includes('post_variant_alt_texts'))).toBe(false);
  });

  it('reads four batches for text, shared media, variant media, scalar polls and genuinely empty content', async () => {
    const text = await seedPost(scope, {
      content: {
        variants: [
          {
            source: 'author',
            text: 'A useful detailed explanation of the software update and its security fixes.',
          },
        ],
      },
    });
    const shared = await seedPost(scope, {
      content: {
        variants: [{ source: 'author', text: '' }],
        media: [{ id: 'gate-shared', type: 'image' }],
      },
    });
    const variant = await seedPost(scope, {
      content: {
        variants: [{ source: 'author', text: '', media: [{ id: 'gate-variant', type: 'image' }] }],
      },
    });
    const poll = await seedPost(scope, {
      content: { variants: [{ source: 'author', text: '' }], pollId: 'gate-poll' },
    });
    const empty = await seedPost(scope, {
      content: { variants: [{ source: 'author', text: '' }] },
    });
    const ids = [text.id, shared.id, variant.id, poll.id, empty.id];
    const shells = assembleShellRecords(
      await getDb().select().from(schema.posts).where(inArray(schema.posts.id, ids)),
    );
    const original = shells.find((post) => post.id === text.id);
    if (!original || !lowEffortGateFilter.keep || !minLengthFilter.keep)
      throw new Error('Missing fixture or filter');
    // Reproduce the false rejection before persisted content is projected.
    expect(lowEffortGateFilter.keep(original, {}, {})).toBe(false);
    expect(minLengthFilter.keep(original, {}, { minLength: 20 })).toBe(false);
    const queries: string[] = [];
    const observed = drizzle(getPostgresClient(), {
      schema,
      casing: 'snake_case',
      logger: {
        logQuery: (query) => {
          queries.push(query);
        },
      },
    });
    const evidence = await loadPostGateContent([...ids, ...ids], observed);
    expect(queries).toHaveLength(4);
    expect(queries.every((query) => query.startsWith('select '))).toBe(true);
    const views = shells.map((post) => ({
      ...post,
      content: { ...post.content, ...evidence.get(post.id) },
    }));
    expect(
      views
        .filter((post) => lowEffortGateFilter.keep?.(post, {}, {}))
        .map((post) => post.id)
        .sort(),
    ).toEqual([text.id, shared.id, variant.id, poll.id].sort());
    expect(
      views
        .filter((post) => minLengthFilter.keep?.(post, {}, { minLength: 20 }))
        .map((post) => post.id),
    ).toEqual([text.id]);
    expect(original.content.variants).toBeUndefined();
    expect(evidence.get(variant.id)?.variants?.[0].media?.[0].id).toBe('gate-variant');
    expect(evidence.get(text.id)).not.toHaveProperty('authorship');
    queries.length = 0;
    await loadPostGateContent([text.id], observed);
    expect(queries).toHaveLength(4);
    queries.length = 0;
    expect(await loadPostGateContent([], observed)).toEqual(new Map());
    expect(queries).toHaveLength(0);
  });
});
