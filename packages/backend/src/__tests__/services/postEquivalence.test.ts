import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { postEquivalenceClusters, posts } from '../../db/schema/posts';
import { postContentVariants, postMedia } from '../../db/schema/postContent';
import { federatedActors } from '../../db/schema/federation';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import { upsertActor } from '../../db/federation/actorRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { notCollapsedCrosspostSql } from '../../utils/feedQueryBuilder';
import { findClusterByPostId } from '../../db/posts/postEquivalenceRepository';
import {
  CROSSPOST_WINDOW_MS,
  detectCrosspostEquivalence,
  loadCrosspostVariants,
  networkLabel,
  reevaluateClusterForPost,
  sharedMediaIdentifier,
} from '../../services/PostEquivalenceService';

/**
 * ONE CARD FOR A CROSS-POST, TWO OBJECTS IN STORAGE.
 *
 * The positive cases here are the small half. What this suite is really for is
 * the refusals, because the two failures are not comparable: a missed collapse
 * shows a reader two cards, while a wrong one attributes one post's engagement,
 * replies and provenance to a different post — potentially a different person's.
 * Every threshold in `PostEquivalenceService` is set on that asymmetry, and each
 * of them is asserted here as a refusal rather than assumed from the code.
 *
 * The Oxy-user gate is the load-bearing one and is why the fixtures go to the
 * trouble of real `federated_actors` rows: a post's NETWORK is read off the
 * authoring actor's identity (`network_acct`, falling back to `domain`), never
 * off the bridge host it arrived through, and a stand-in would let the whole
 * suite pass while the live path compared `kilogram.makeup` against `threads.net`
 * and found no reviewed pair for either.
 */

const PERSON = 'oxy-crosspost-person';
const OTHER_PERSON = 'oxy-crosspost-other';

/**
 * THE HANDLE IS NAMESPACED TO THIS SUITE; THE DOMAIN IS NOT, AND CANNOT BE.
 *
 * The whole run shares one database, so a fixture that squats on a real public
 * handle is a row another file can also claim. `federated_actors` carries a
 * UNIQUE `(domain, username)` — so a second suite seeding `zuck@bird.makeup` at
 * its own URI makes this file's URI-keyed upsert conflict — and several
 * federation suites clean up by URI prefix, which would take these rows with
 * them mid-file. Every other federation suite avoids all of that through
 * `federationScope(name)`, which namespaces to `<name>.test`.
 *
 * This one cannot use that helper, because the DOMAIN is what is under test:
 * `findCrossNetworkPair` keys on identity domains, so `instagram.com` and
 * `threads.net` have to be real or the layer refuses every pair and the suite
 * passes vacuously. So the namespacing moves to the HANDLE instead — unique to
 * this file, on the real hosts — which closes both collisions while leaving the
 * networks intact.
 */
const SUITE = 'postequiv';
const IG_HANDLE = `${SUITE}-zuck`;
const IG_ACTOR = `https://kilogram.makeup/users/${IG_HANDLE}`;
const THREADS_ACTOR = `https://threads.net/ap/users/${SUITE}-17841401746480004/`;
const X_ACTOR = `https://bird.makeup/users/${IG_HANDLE}`;

let db: Database;
const created: string[] = [];
const seededActors: string[] = [];

async function seedActor(uri: string, username: string, domain: string, networkAcct?: string) {
  await upsertActor(
    uri,
    {
      protocol: 'activitypub',
      username,
      domain,
      acct: `${username}@${domain}`,
      ...(networkAcct ? { networkAcct } : {}),
      type: 'Person',
      manuallyApprovesFollowers: false,
      discoverable: true,
      memorial: false,
      suspended: false,
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      lastFetchedAt: new Date(),
    },
    [],
  );
  seededActors.push(uri);
}

interface VariantInput {
  actorUri: string;
  text: string;
  createdAt: Date;
  oxyUserId?: string;
  federationUrl?: string;
  media?: { remoteUrl: string; width: number; height: number; sizeBytes: number }[];
}

/** One network's copy of a post, stored exactly as the federated ingest leaves it. */
async function createVariant(input: VariantInput): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: input.oxyUserId ?? PERSON,
    authorship: [{ oxyUserId: input.oxyUserId ?? PERSON, role: 'owner', status: 'accepted' }],
    type: input.media?.length ? PostType.IMAGE : PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: input.text, tag: 'en' }] },
    federation: {
      activityId: `${input.actorUri}/statuses/${Math.random().toString(36).slice(2)}`,
      actorUri: input.actorUri,
      url: input.federationUrl,
    },
  } as PostRecordInput);
  created.push(record.id);

  await db
    .update(posts)
    .set({ createdAt: input.createdAt, updatedAt: input.createdAt })
    .where(eq(posts.id, record.id));

  if (input.media?.length) {
    await db.insert(postMedia).values(
      input.media.map((item, position) => ({
        postId: record.id,
        position,
        mediaId: item.remoteUrl,
        type: 'image' as const,
        remoteUrl: item.remoteUrl,
        width: item.width,
        height: item.height,
        sizeBytes: item.sizeBytes,
        createdAt: input.createdAt,
      })),
    );
  }
  return record.id;
}

const PHOTO_A = 'https://scontent.cdninstagram.com/v/t51.2885-15/489123456789012_n.jpg?stp=dst&_nc_cat=1';
const PHOTO_A_ON_THREADS = 'https://scontent-lhr.xx.fbcdn.net/v/t51.2885-15/489123456789012_n.jpg?oh=00_A&oe=1';
const PHOTO_B = 'https://scontent.cdninstagram.com/v/t51.2885-15/222999888777666_n.jpg';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const MEDIA = [{ remoteUrl: PHOTO_A, width: 1080, height: 1350, sizeBytes: 204800 }];
const MEDIA_ON_THREADS = [
  { remoteUrl: PHOTO_A_ON_THREADS, width: 1080, height: 1350, sizeBytes: 204800 },
];

beforeAll(async () => {
  db = await connectPostgres();
});

/**
 * Re-seeded per TEST, not once per file.
 *
 * `seedActor` upserts, so this is idempotent and cheap — and it means a row
 * removed between tests (by this suite's own cleanup, or by anything else
 * sharing the database) cannot cascade into every case that follows. Without
 * it, one lost actor turns the rest of the file into `not-applicable`: a post
 * whose authoring actor is missing has no NETWORK, so `loadCandidate` refuses
 * it and every collapse assertion fails for a reason that has nothing to do
 * with cross-posts.
 */
beforeEach(async () => {
  await seedActor(IG_ACTOR, IG_HANDLE, 'kilogram.makeup', `${IG_HANDLE}@instagram.com`);
  await seedActor(THREADS_ACTOR, IG_HANDLE, 'threads.net');
  await seedActor(X_ACTOR, IG_HANDLE, 'bird.makeup', `${IG_HANDLE}@x.com`);
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id).catch(() => undefined);
  }
  await getDb().delete(postEquivalenceClusters);
});

afterAll(async () => {
  if (seededActors.length > 0) {
    await getDb().delete(federatedActors).where(inArray(federatedActors.uri, seededActors));
  }
  await closePostgres();
});

/** The ids a reader-facing feed query would return for this suite's posts. */
async function visibleIds(): Promise<string[]> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(inArray(posts.id, created), notCollapsedCrosspostSql()));
  return rows.map((row) => row.id).sort();
}

describe('what collapses', () => {
  it('collapses identical text and media published minutes apart', async () => {
    const instagram = await createVariant({
      actorUri: IG_ACTOR,
      text: 'building in the open',
      createdAt: NOW,
      media: MEDIA,
    });
    const threads = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'building in the open',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
    });

    const decision = await detectCrosspostEquivalence({ postId: threads });

    expect(decision.outcome).toBe('clustered');
    // The asset id survives two different Meta CDN hosts and two sets of signed
    // query parameters, which is what makes this tier deterministic rather than
    // a guess about timing.
    expect(decision.reason).toBe('shared-media-id');

    // Both objects are STILL STORED and both are still addressable.
    const stored = await db.select({ id: posts.id }).from(posts).where(inArray(posts.id, [instagram, threads]));
    expect(stored).toHaveLength(2);
    // Exactly one of them renders.
    expect(await visibleIds()).toHaveLength(1);
  });

  it('collapses on an explicit declared original, whatever else disagrees', async () => {
    await createVariant({
      actorUri: IG_ACTOR,
      text: 'the original caption',
      createdAt: NOW,
      federationUrl: 'https://www.instagram.com/p/DAbCdEf/',
    });
    const threads = await createVariant({
      actorUri: THREADS_ACTOR,
      // Different text and no media: only the declaration links them, which is
      // the point of putting it above every heuristic.
      text: 'a completely different sentence',
      createdAt: new Date(NOW.getTime() + 9 * 60_000),
    });

    const decision = await detectCrosspostEquivalence({
      postId: threads,
      declaredOriginalUrls: ['https://www.instagram.com/p/DAbCdEf/'],
    });

    expect(decision).toMatchObject({ outcome: 'clustered', reason: 'declared' });
  });

  it('renders the richer variant, not the one that happened to arrive first', async () => {
    const fullResolution = await createVariant({
      actorUri: IG_ACTOR,
      text: 'same words',
      createdAt: NOW,
      media: MEDIA,
    });
    const downscaled = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 30_000),
      // The SAME asset — so the shared-media-id tier still links them — served
      // at a smaller size, which is the ordinary shape of one Meta upload
      // reaching two apps.
      media: [{ remoteUrl: PHOTO_A_ON_THREADS, width: 640, height: 800, sizeBytes: 90000 }],
    });

    await detectCrosspostEquivalence({ postId: downscaled });

    // `downscaled` arrived second and triggered the detection; preference is
    // decided from the members, so the full-resolution variant still wins.
    expect(await visibleIds()).toEqual([fullResolution]);
  });
});

describe('what must never collapse', () => {
  it('refuses the same content from two DIFFERENT people', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: 'same words', createdAt: NOW, media: MEDIA });
    const theirs = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
      oxyUserId: OTHER_PERSON,
    });

    expect(await detectCrosspostEquivalence({ postId: theirs })).toMatchObject({
      outcome: 'refused',
      reason: 'no-sibling-in-window',
    });
    expect(await visibleIds()).toHaveLength(2);
  });

  it('refuses two networks that are not a reviewed pair, even for one person', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: 'same words', createdAt: NOW, media: MEDIA });
    const onX = await createVariant({
      actorUri: X_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
    });

    expect(await detectCrosspostEquivalence({ postId: onX })).toMatchObject({ outcome: 'refused' });
    expect(await visibleIds()).toHaveLength(2);
  });

  it('refuses the same author repeating themselves outside the window', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: 'good morning', createdAt: NOW, media: MEDIA });
    const later = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'good morning',
      createdAt: new Date(NOW.getTime() + CROSSPOST_WINDOW_MS + 60_000),
      media: MEDIA_ON_THREADS,
    });

    expect(await detectCrosspostEquivalence({ postId: later })).toMatchObject({
      outcome: 'refused',
      reason: 'no-sibling-in-window',
    });
  });

  /**
   * One person can intentionally write the same sentence on both accounts, which
   * is why a text-only pair gets minutes rather than half an hour — and why the
   * media tier, which has an asset id behind it, is allowed the wider one.
   */
  it('refuses a text-only pair outside its own tighter window', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: 'good morning', createdAt: NOW });
    const later = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'good morning',
      createdAt: new Date(NOW.getTime() + 20 * 60_000),
    });

    expect(await detectCrosspostEquivalence({ postId: later })).toMatchObject({
      outcome: 'refused',
      reason: 'no-sufficient-evidence',
    });
  });

  it('refuses similar-but-not-identical media at any confidence', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: 'same words', createdAt: NOW, media: MEDIA });
    const different = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      // A different asset, and a re-encode close enough that a perceptual hash
      // would call it a match. Nothing here computes one, deliberately.
      media: [{ remoteUrl: PHOTO_B, width: 1080, height: 1350, sizeBytes: 204801 }],
    });

    expect(await detectCrosspostEquivalence({ postId: different })).toMatchObject({
      outcome: 'refused',
      reason: 'no-sufficient-evidence',
    });
  });

  it('refuses two empty bodies, which are equal to every other empty body', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: '', createdAt: NOW });
    const other = await createVariant({
      actorUri: THREADS_ACTOR,
      text: '',
      createdAt: new Date(NOW.getTime() + 10_000),
    });

    expect(await detectCrosspostEquivalence({ postId: other })).toMatchObject({
      outcome: 'refused',
    });
  });
});

describe('a cluster that has stopped being true', () => {
  async function collapsedPair(): Promise<{ instagram: string; threads: string }> {
    const instagram = await createVariant({
      actorUri: IG_ACTOR,
      text: 'same words',
      createdAt: NOW,
      media: MEDIA,
    });
    const threads = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
    });
    await detectCrosspostEquivalence({ postId: threads });
    expect(await visibleIds()).toHaveLength(1);
    return { instagram, threads };
  }

  it('splits when an edit makes one variant materially different', async () => {
    const { threads } = await collapsedPair();

    // The Threads copy grows text the Instagram caption never had.
    await db
      .update(posts)
      .set({ isEdited: true })
      .where(eq(posts.id, threads));
    // The body lives in the variants table; the edit path rewrites it there.
    // Written directly rather than through the whole Update handler, so what is
    // under test is the re-evaluation and not the ingest.
    await db
      .update(postContentVariants)
      .set({ body: 'same words, and three more paragraphs' })
      .where(and(eq(postContentVariants.postId, threads), eq(postContentVariants.position, 0)));

    await reevaluateClusterForPost(threads);

    // Both visible again: an author's new text must not be hidden because the
    // ORIGINAL versions matched.
    expect(await visibleIds()).toHaveLength(2);
    expect(await findClusterByPostId(threads)).toBeNull();
  });

  it('keeps the survivor visible when the other variant is deleted', async () => {
    const { instagram, threads } = await collapsedPair();
    // Delete whichever one is currently rendered, so the survivor is the
    // collapsed half — the case that would otherwise hide a live post forever.
    const [renderedId] = await visibleIds();
    const survivorId = renderedId === instagram ? threads : instagram;

    const { deletePostSubtree } = await import('../../services/PostDeletionCascade');
    await deletePostSubtree(renderedId, undefined);
    created.splice(created.indexOf(renderedId), 1);

    const [survivor] = await db
      .select({ id: posts.id, collapsed: posts.crosspostCollapsed })
      .from(posts)
      .where(eq(posts.id, survivorId));
    expect(survivor).toMatchObject({ collapsed: false });
    expect(await visibleIds()).toEqual([survivorId]);
  });
});

describe('provenance for the rendered card', () => {
  it('names both networks, marks the rendered one, and links the hidden variant', async () => {
    const instagram = await createVariant({
      actorUri: IG_ACTOR,
      text: 'same words',
      createdAt: NOW,
      media: MEDIA,
    });
    const threads = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
    });
    await detectCrosspostEquivalence({ postId: threads });

    const variants = await loadCrosspostVariants([instagram, threads]);

    // Both posts answer, because either can be the one a surface fetched.
    expect(variants.get(instagram)).toHaveLength(2);
    expect(variants.get(threads)).toHaveLength(2);

    const forCard = variants.get(instagram)!;
    expect(forCard.map((variant) => variant.networkDomain).sort()).toEqual([
      'instagram.com',
      'threads.net',
    ]);
    // Exactly one is the representative — the card renders that one and names
    // the rest.
    expect(forCard.filter((variant) => variant.preferred)).toHaveLength(1);
    // The hidden variant is reachable: its post id is a real Mention post, so
    // the affordance is an internal `/p/<id>` route rather than a link off-site.
    const hidden = forCard.find((variant) => !variant.preferred)!;
    expect([instagram, threads]).toContain(hidden.postId);
  });

  it('puts the representative first, so two readers see one order', async () => {
    await createVariant({ actorUri: IG_ACTOR, text: 'same words', createdAt: NOW, media: MEDIA });
    const threads = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
    });
    await detectCrosspostEquivalence({ postId: threads });

    const forCard = (await loadCrosspostVariants([threads])).get(threads)!;
    expect(forCard[0].preferred).toBe(true);
  });

  it('answers nothing for a post in no cluster — which is almost every post', async () => {
    const lonely = await createVariant({ actorUri: IG_ACTOR, text: 'alone', createdAt: NOW });

    expect((await loadCrosspostVariants([lonely])).get(lonely)).toBeUndefined();
  });

  it('reads the network off the actor identity, never the bridge host', async () => {
    const instagram = await createVariant({
      actorUri: IG_ACTOR,
      text: 'same words',
      createdAt: NOW,
      media: MEDIA,
    });
    const threads = await createVariant({
      actorUri: THREADS_ACTOR,
      text: 'same words',
      createdAt: new Date(NOW.getTime() + 60_000),
      media: MEDIA_ON_THREADS,
    });
    await detectCrosspostEquivalence({ postId: threads });

    const domains = (await loadCrosspostVariants([instagram])).get(instagram)!
      .map((variant) => variant.networkDomain);
    // The Instagram copy reached us through `kilogram.makeup`. A reader must
    // never be told that is the network it came from.
    expect(domains).toContain('instagram.com');
    expect(domains.join(' ')).not.toContain('kilogram.makeup');
  });
});

describe('networkLabel', () => {
  it.each([
    ['instagram.com', 'Instagram'],
    ['threads.net', 'Threads'],
    ['INSTAGRAM.COM', 'Instagram'],
  ])('renders %s as %s', (domain, expected) => {
    expect(networkLabel(domain)).toBe(expected);
  });

  it('falls back to the domain for a network no declaration covers', () => {
    // Truthful rather than blank: a reader seeing the domain learns something,
    // and an empty chip looks like a bug.
    expect(networkLabel('example.social')).toBe('example.social');
  });
});

describe('pagination', () => {
  /**
   * THE REASON THE COLLAPSE IS A QUERY TERM AND NOT A POST-FETCH FILTER.
   *
   * Dropping the duplicates after the page is fetched returns the requested
   * number of ROWS and fewer CARDS — the feed pages correctly and looks short,
   * which reads to a reader as "the feed ran out" and to an operator as a
   * ranking change rather than a defect. Excluding them in the query means the
   * page is filled with real candidates before it is cut, so a page of three is
   * three cards however many collapsed variants sit between them.
   */
  it('fills the requested page rather than returning it short', async () => {
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(NOW.getTime() + i * 60 * 60_000);
      const asset = `https://scontent.cdninstagram.com/v/t51.2885-15/99900000000000${i}_n.jpg`;
      await createVariant({
        actorUri: IG_ACTOR,
        text: `post ${i}`,
        createdAt: at,
        media: [{ remoteUrl: asset, width: 1080, height: 1350, sizeBytes: 100000 + i }],
      });
      const threads = await createVariant({
        actorUri: THREADS_ACTOR,
        text: `post ${i}`,
        createdAt: new Date(at.getTime() + 30_000),
        media: [
          { remoteUrl: `${asset}?oh=00_A&oe=1`, width: 1080, height: 1350, sizeBytes: 100000 + i },
        ],
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await detectCrosspostEquivalence({ postId: threads })).toMatchObject({
        outcome: 'clustered',
      });
    }

    // Six stored objects, three of them collapsed.
    expect(created).toHaveLength(6);
    const page = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(inArray(posts.id, created), notCollapsedCrosspostSql()))
      .orderBy(posts.createdAt)
      .limit(3);

    expect(page).toHaveLength(3);
    expect(new Set(page.map((row) => row.id)).size).toBe(3);
  });
});

describe('sharedMediaIdentifier', () => {
  it('survives a different CDN host and different signed query parameters', () => {
    expect(sharedMediaIdentifier(PHOTO_A)).toBe(sharedMediaIdentifier(PHOTO_A_ON_THREADS));
  });

  it.each([
    ['a generic filename', 'https://example.com/uploads/image.jpg'],
    ['a short numeric name', 'https://example.com/1.png'],
    ['a word with no digits', 'https://example.com/photographs/sunset.jpeg'],
    ['no path at all', 'https://example.com/'],
    ['not a url', 'image.jpg'],
    ['nothing', null],
  ])('refuses %s, which names an asset on a thousand sites', (_label, url) => {
    expect(sharedMediaIdentifier(url)).toBeUndefined();
  });
});
