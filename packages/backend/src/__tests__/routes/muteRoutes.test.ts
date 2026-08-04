/**
 * `/mute` and `/mute-words` against real rows.
 *
 * The interesting half is `mute_words`. Mongoose applied `maxlength: 100` and
 * nothing else — no `trim`, no `lowercase` — so ALL of the normalization that
 * makes `(user_id, value)` a meaningful unique key has always lived at the call
 * site, in `normalizeMuteValue`. Postgres has no counterpart to a Mongoose
 * setter, so if that normalization ever drifts out of the route, a padded or
 * mixed-case duplicate stops colliding and the viewer silently accumulates two
 * rules that mean the same thing. Every "still collides" case below is that.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, or } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { muteWords, mutes } from '../../db/schema/engagement';
import muteRouter from '../../routes/mute.routes';
import muteWordsRouter from '../../routes/muteWords.routes';

let db: Database;
const createdUserIds: string[] = [];

function userId(label: string): string {
  const id = `oxy-${label}-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

function makeApp(viewer: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (viewer) (req as typeof req & { user: { id: string } }).user = { id: viewer };
    next();
  });
  app.use('/mute', muteRouter);
  app.use('/mute-words', muteWordsRouter);
  return app;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db
      .delete(mutes)
      .where(or(inArray(mutes.userId, createdUserIds), inArray(mutes.mutedId, createdUserIds)));
    await db.delete(muteWords).where(inArray(muteWords.userId, createdUserIds));
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('POST /mute', () => {
  it('creates one row, and a repeat answers 200 with the SAME row', async () => {
    const viewer = userId('muter');
    const target = userId('muted');
    const app = makeApp(viewer);

    const created = await request(app).post('/mute').send({ mutedId: target }).expect(201);
    expect(created.body.mute._id).toEqual(expect.any(String));

    const repeat = await request(app).post('/mute').send({ mutedId: target }).expect(200);
    expect(repeat.body.message).toBe('User already muted');
    expect(repeat.body.mute._id).toBe(created.body.mute._id);

    expect(await db.select().from(mutes).where(eq(mutes.userId, viewer))).toHaveLength(1);
  });

  it('refuses self-muting, a missing target, and an anonymous caller', async () => {
    const viewer = userId('muter');
    await request(makeApp(viewer)).post('/mute').send({ mutedId: viewer }).expect(400);
    await request(makeApp(viewer)).post('/mute').send({}).expect(400);
    await request(makeApp(undefined)).post('/mute').send({ mutedId: 'someone' }).expect(401);
    expect(await db.select().from(mutes).where(eq(mutes.userId, viewer))).toEqual([]);
  });

  it('emits _id on the wire, the key a Mongoose document serialized to', async () => {
    const viewer = userId('muter');
    const target = userId('muted');
    const res = await request(makeApp(viewer)).post('/mute').send({ mutedId: target }).expect(201);

    expect(res.body.mute).toMatchObject({ userId: viewer, mutedId: target });
    expect(res.body.mute).not.toHaveProperty('id');
    expect(res.body.mute).not.toHaveProperty('__v');
    expect(typeof res.body.mute.createdAt).toBe('string');
  });
});

describe('DELETE /mute/:mutedId and GET /mute', () => {
  it('lists the viewer’s mutes newest first and removes one by id', async () => {
    const viewer = userId('muter');
    const older = userId('older');
    const newer = userId('newer');
    await db.insert(mutes).values([
      { userId: viewer, mutedId: older, createdAt: new Date('2026-07-01T00:00:00.000Z') },
      { userId: viewer, mutedId: newer, createdAt: new Date('2026-07-02T00:00:00.000Z') },
    ]);

    const listed = await request(makeApp(viewer)).get('/mute').expect(200);
    expect(listed.body.count).toBe(2);
    expect(listed.body.mutes.map((row: { mutedId: string }) => row.mutedId)).toEqual([
      newer,
      older,
    ]);

    await request(makeApp(viewer)).delete(`/mute/${newer}`).expect(200);
    const after = await request(makeApp(viewer)).get('/mute').expect(200);
    expect(after.body.mutes.map((row: { mutedId: string }) => row.mutedId)).toEqual([older]);
  });

  it('404s an unmute of something that is not muted, and leaves nobody else’s row', async () => {
    const viewer = userId('muter');
    const stranger = userId('stranger');
    const target = userId('muted');
    await db.insert(mutes).values({ userId: stranger, mutedId: target });

    await request(makeApp(viewer)).delete(`/mute/${target}`).expect(404);
    expect(await db.select().from(mutes).where(eq(mutes.userId, stranger))).toHaveLength(1);
  });

  it('answers the check endpoint per direction', async () => {
    const viewer = userId('muter');
    const target = userId('muted');
    await request(makeApp(viewer)).post('/mute').send({ mutedId: target }).expect(201);

    expect((await request(makeApp(viewer)).get(`/mute/check/${target}`)).body).toEqual({
      isMuted: true,
    });
    expect((await request(makeApp(target)).get(`/mute/check/${viewer}`)).body).toEqual({
      isMuted: false,
    });
  });
});

describe('POST /mute-words normalization', () => {
  it('trims the value, so a padded duplicate still collides', async () => {
    // Mongoose never trimmed this field either — the zod transform and
    // `normalizeMuteValue` did, and they are what the unique key depends on.
    const viewer = userId('muter');
    const app = makeApp(viewer);

    const created = await request(app).post('/mute-words').send({ value: 'spoilers' }).expect(201);
    const padded = await request(app).post('/mute-words').send({ value: '   spoilers  ' }).expect(200);

    expect(padded.body.data.id).toBe(created.body.data.id);
    expect(created.body.data.value).toBe('spoilers');
    expect(await db.select().from(muteWords).where(eq(muteWords.userId, viewer))).toHaveLength(1);
  });

  it('lowercases a tag-only value, so a mixed-case duplicate still collides', async () => {
    const viewer = userId('muter');
    const app = makeApp(viewer);

    const created = await request(app)
      .post('/mute-words')
      .send({ value: 'Politics', targets: ['tag'] })
      .expect(201);
    expect(created.body.data.value).toBe('politics');

    const mixed = await request(app)
      .post('/mute-words')
      .send({ value: 'POLITICS', targets: ['tag'] })
      .expect(200);
    expect(mixed.body.data.id).toBe(created.body.data.id);
  });

  it('strips a leading # and forces the tag target', async () => {
    const viewer = userId('muter');
    const res = await request(makeApp(viewer))
      .post('/mute-words')
      .send({ value: '#Election2026' })
      .expect(201);

    expect(res.body.data.value).toBe('election2026');
    expect(res.body.data.targets).toEqual(expect.arrayContaining(['tag']));

    const [row] = await db.select().from(muteWords).where(eq(muteWords.userId, viewer));
    expect(row.value).toBe('election2026');
  });

  it('PRESERVES case for a content target, which the matcher handles case-insensitively', async () => {
    // The vacuity floor for the two lowercase cases above: normalization is
    // target-dependent, and lowercasing everything would be just as wrong.
    const viewer = userId('muter');
    const res = await request(makeApp(viewer))
      .post('/mute-words')
      .send({ value: 'Barcelona', targets: ['content'] })
      .expect(201);
    expect(res.body.data.value).toBe('Barcelona');
  });

  it('rejects a value that normalizes to nothing', async () => {
    const viewer = userId('muter');
    await request(makeApp(viewer)).post('/mute-words').send({ value: '#' }).expect(400);
    await request(makeApp(viewer)).post('/mute-words').send({ value: '   ' }).expect(400);
    expect(await db.select().from(muteWords).where(eq(muteWords.userId, viewer))).toEqual([]);
  });

  it('rejects a value longer than the column allows, before the CHECK can', async () => {
    const viewer = userId('muter');
    await request(makeApp(viewer))
      .post('/mute-words')
      .send({ value: 'a'.repeat(101) })
      .expect(400);
    expect(await db.select().from(muteWords).where(eq(muteWords.userId, viewer))).toEqual([]);
  });

  it('stores actorTarget, defaulting to `all`', async () => {
    const viewer = userId('muter');
    const app = makeApp(viewer);

    const byDefault = await request(app).post('/mute-words').send({ value: 'one' }).expect(201);
    expect(byDefault.body.data.actorTarget).toBe('all');

    const explicit = await request(app)
      .post('/mute-words')
      .send({ value: 'two', actorTarget: 'exclude-following' })
      .expect(201);
    expect(explicit.body.data.actorTarget).toBe('exclude-following');
  });

  it('scopes the unique key to the user — two people may mute the same word', async () => {
    const first = userId('muter');
    const second = userId('muter');
    await request(makeApp(first)).post('/mute-words').send({ value: 'spoilers' }).expect(201);
    await request(makeApp(second)).post('/mute-words').send({ value: 'spoilers' }).expect(201);

    expect(
      await db.select().from(muteWords).where(inArray(muteWords.userId, [first, second])),
    ).toHaveLength(2);
  });
});

describe('the mute_words constraints themselves', () => {
  it('refuses a duplicate (user, value) written by hand', async () => {
    // The vacuity floor for the normalization cases: without the unique index
    // they would pass against a route that simply never inserted twice.
    const viewer = userId('muter');
    const values = { userId: viewer, value: 'spoilers', targets: ['content'] };
    await db.insert(muteWords).values(values);
    await expect(db.insert(muteWords).values(values)).rejects.toThrow();
  });

  it('refuses a targets element outside the allowed set', async () => {
    const viewer = userId('muter');
    await expect(
      db.insert(muteWords).values({ userId: viewer, value: 'x', targets: ['content', 'elsewhere'] }),
    ).rejects.toThrow();
  });

  it('refuses a value over 100 characters', async () => {
    const viewer = userId('muter');
    await expect(
      db.insert(muteWords).values({ userId: viewer, value: 'a'.repeat(101), targets: ['content'] }),
    ).rejects.toThrow();
  });
});

describe('GET/PATCH/DELETE /mute-words', () => {
  it('lists newest first and updates only the fields the request names', async () => {
    const viewer = userId('muter');
    const app = makeApp(viewer);

    await db.insert(muteWords).values([
      {
        userId: viewer,
        value: 'older',
        targets: ['content'],
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        userId: viewer,
        value: 'newer',
        targets: ['content'],
        actorTarget: 'exclude-following',
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
      },
    ]);

    const listed = await request(app).get('/mute-words').expect(200);
    expect(listed.body.data.map((row: { value: string }) => row.value)).toEqual(['newer', 'older']);

    const target = listed.body.data[0];
    const patched = await request(app)
      .patch(`/mute-words/${target.id}`)
      .send({ targets: ['tag'] })
      .expect(200);

    // `targets` moved; `actorTarget` was not named and must be untouched —
    // drizzle keys `set()` by column property and silently ignores an unknown
    // key, so a mistyped one would answer 200 having written nothing.
    expect(patched.body.data.targets).toEqual(['tag']);
    expect(patched.body.data.actorTarget).toBe('exclude-following');

    const [stored] = await db.select().from(muteWords).where(eq(muteWords.id, target.id));
    expect(stored.targets).toEqual(['tag']);
    expect(stored.actorTarget).toBe('exclude-following');
  });

  it('refuses to patch or delete another user’s entry', async () => {
    const owner = userId('owner');
    const stranger = userId('stranger');
    const [row] = await db
      .insert(muteWords)
      .values({ userId: owner, value: 'private', targets: ['content'] })
      .returning();

    const app = makeApp(stranger);
    await request(app).patch(`/mute-words/${row.id}`).send({ targets: ['tag'] }).expect(404);
    await request(app).delete(`/mute-words/${row.id}`).expect(404);

    // Refused, and still intact — a rejection that had also written would pass
    // an assertion on the status alone.
    const [stored] = await db.select().from(muteWords).where(eq(muteWords.id, row.id));
    expect(stored.targets).toEqual(['content']);
  });

  it('400s an empty patch and 404s an id that names nothing', async () => {
    const viewer = userId('muter');
    const app = makeApp(viewer);
    const [row] = await db
      .insert(muteWords)
      .values({ userId: viewer, value: 'x', targets: ['content'] })
      .returning();

    await request(app).patch(`/mute-words/${row.id}`).send({}).expect(400);
    await request(app).patch(`/mute-words/${uuidv7()}`).send({ targets: ['tag'] }).expect(404);
    await request(app).delete(`/mute-words/${uuidv7()}`).expect(404);
  });

  it('400s a malformed id — the documented contract validateObjectId keeps', async () => {
    const viewer = userId('muter');
    await request(makeApp(viewer)).delete('/mute-words/not-an-id').expect(400);
  });

  it('deletes the viewer’s own entry', async () => {
    const viewer = userId('muter');
    const [row] = await db
      .insert(muteWords)
      .values({ userId: viewer, value: 'x', targets: ['content'] })
      .returning();

    await request(makeApp(viewer)).delete(`/mute-words/${row.id}`).expect(200);
    expect(await db.select().from(muteWords).where(eq(muteWords.id, row.id))).toEqual([]);
  });
});
