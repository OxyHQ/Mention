/**
 * The two spatial columns, asserted against REAL ROWS.
 *
 * The point of this file is the ORDERING check. `ST_MakePoint` takes
 * `(longitude, latitude)` and Mongo stored `{ lat, lon }` pairs that a
 * `2dsphere` index reads POSITIONALLY, so a transposed pair is the single most
 * likely thing to get wrong here — and it does not look wrong: a lat/lon swap
 * yields a perfectly plausible point in the wrong hemisphere. A test that only
 * asserts "a row came back" passes against exactly that bug.
 *
 * So every spatial assertion below is anchored to an INDEPENDENTLY CHECKABLE
 * real-world distance: Barcelona to Madrid is ~505 km, and the transposed pair
 * lands in the Indian Ocean over 5000 km from either.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { GENERATED_ALWAYS, sqlStateOf } from '@oxyhq/db';
import { posts } from '../../db/schema/posts';

/** Barcelona city centre. */
const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };
/** Madrid city centre. */
const MADRID = { latitude: 40.4168, longitude: -3.7038 };
/** The real great-circle distance between them, in metres (~505 km). */
const BARCELONA_TO_MADRID_METRES = 505_000;
/** Tolerance on that figure. Generous — it is guarding an ordering bug, not geodesy. */
const DISTANCE_TOLERANCE_METRES = 20_000;

let db: Database;
const createdPostIds: string[] = [];

async function insertPostAt(
  coordinates: { latitude: number; longitude: number }
): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      oxyUserId: 'oxy-test-author',
      locationLatitude: coordinates.latitude,
      locationLongitude: coordinates.longitude,
    })
    .returning({ id: posts.id });
  if (!row) throw new Error('insert returned no row');
  createdPostIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (createdPostIds.length > 0) {
    const id = createdPostIds.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('posts.geo', () => {
  it('is a SRID 4326 point built as (longitude, latitude)', async () => {
    const id = await insertPostAt(BARCELONA);

    const rows = await db.execute<{
      srid: number;
      geometry_type: string;
      longitude: number;
      latitude: number;
    }>(sql`
      select
        ST_SRID(geo) as srid,
        GeometryType(geo::geometry) as geometry_type,
        ST_X(geo::geometry) as longitude,
        ST_Y(geo::geometry) as latitude
      from posts
      where id = ${id}
    `);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.srid).toBe(4326);
    expect(row.geometry_type).toBe('POINT');
    // The ordering assertion: X is the LONGITUDE and Y is the LATITUDE. A
    // transposed pair would put X at 41.38 and Y at 2.16 and still be a valid
    // point.
    expect(row.longitude).toBeCloseTo(BARCELONA.longitude, 6);
    expect(row.latitude).toBeCloseTo(BARCELONA.latitude, 6);
  });

  it('measures a real-world distance correctly, which a lat/lon swap cannot', async () => {
    const barcelona = await insertPostAt(BARCELONA);
    const madrid = await insertPostAt(MADRID);

    const rows = await db.execute<{ metres: number }>(sql`
      select ST_Distance(a.geo, b.geo) as metres
      from posts a, posts b
      where a.id = ${barcelona} and b.id = ${madrid}
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].metres).toBeGreaterThan(
      BARCELONA_TO_MADRID_METRES - DISTANCE_TOLERANCE_METRES
    );
    expect(rows[0].metres).toBeLessThan(
      BARCELONA_TO_MADRID_METRES + DISTANCE_TOLERANCE_METRES
    );
  });

  it('is NULL when the post carries no coordinates', async () => {
    const [row] = await db
      .insert(posts)
      .values({ oxyUserId: 'oxy-test-author' })
      .returning({ id: posts.id });
    createdPostIds.push(row.id);

    const rows = await db.execute<{ geo: string | null }>(
      sql`select geo::text as geo from posts where id = ${row.id}`
    );
    expect(rows[0].geo).toBeNull();
  });

  it('cannot be written directly', async () => {
    // This is what makes a coordinate-ordering divergence UNREPRESENTABLE rather
    // than merely discouraged: there is no write path — route, service, backfill
    // or psql — that can produce a row whose point disagrees with its columns.
    let caught: unknown;
    try {
      await db.execute(sql`
        insert into posts (id, geo) values ('geo-write-probe', ST_MakePoint(0, 0)::geography)
      `);
    } catch (error) {
      caught = error;
    }
    expect(sqlStateOf(caught)).toBe(GENERATED_ALWAYS);
  });

  it('is backed by a GiST index on both spatial columns', async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select i.relname as indexname
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_am am on am.oid = i.relam
      where t.relname = 'posts' and am.amname = 'gist'
      order by 1
    `);
    expect(rows.map((row) => row.indexname).sort()).toEqual([
      'posts_content_geo_gist',
      'posts_geo_gist',
    ]);
  });
});

describe('posts.content_geo', () => {
  it('is generated from the content coordinates, independently of `geo`', async () => {
    const [row] = await db
      .insert(posts)
      .values({
        oxyUserId: 'oxy-test-author',
        contentLocationLatitude: MADRID.latitude,
        contentLocationLongitude: MADRID.longitude,
        locationLatitude: BARCELONA.latitude,
        locationLongitude: BARCELONA.longitude,
      })
      .returning({ id: posts.id });
    createdPostIds.push(row.id);

    const rows = await db.execute<{
      content_longitude: number;
      content_latitude: number;
      longitude: number;
      latitude: number;
    }>(sql`
      select
        ST_X(content_geo::geometry) as content_longitude,
        ST_Y(content_geo::geometry) as content_latitude,
        ST_X(geo::geometry) as longitude,
        ST_Y(geo::geometry) as latitude
      from posts where id = ${row.id}
    `);

    expect(rows[0].content_longitude).toBeCloseTo(MADRID.longitude, 6);
    expect(rows[0].content_latitude).toBeCloseTo(MADRID.latitude, 6);
    expect(rows[0].longitude).toBeCloseTo(BARCELONA.longitude, 6);
    expect(rows[0].latitude).toBeCloseTo(BARCELONA.latitude, 6);
  });
});

describe('coordinate constraints', () => {
  it('refuses half a coordinate pair', async () => {
    // Mongo allowed it and the federated insert path had to strip half-written
    // pairs by hand (`outbox.service.ts:904`). Here the state is unrepresentable.
    await expect(
      db.insert(posts).values({
        oxyUserId: 'oxy-test-author',
        locationLatitude: BARCELONA.latitude,
      })
    ).rejects.toThrow();
  });

  it('refuses an out-of-range coordinate', async () => {
    await expect(
      db.insert(posts).values({
        oxyUserId: 'oxy-test-author',
        locationLatitude: 91,
        locationLongitude: 0,
      })
    ).rejects.toThrow();
  });
});
