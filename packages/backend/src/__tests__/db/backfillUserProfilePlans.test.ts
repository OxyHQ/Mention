/**
 * The per-viewer plans — `userbehaviors` (three child tables) and `usersettings`
 * (72 columns of defaults, one child table).
 *
 * Four properties carry the weight:
 *
 * - **The two array shapes are not the same problem.** The four negative-signal
 *   arrays stay `text[]` because the ranking context reads them whole; the three
 *   preference arrays are subdocuments with individually-incremented counters
 *   and become child tables. Copying either as the other is silently wrong.
 * - **A default is a claim.** `privacy.showSensitiveContent` absent must become
 *   `false`; being wrong there shows sensitive content to a viewer who never
 *   asked. The ten embed preferences are TRI-STATE and absent means "ask on
 *   first play", so defaulting any of them answers a consent question on the
 *   viewer's behalf.
 * - **`feedTuning` must stay NULL when absent**, because NULL means "never
 *   overrode the gate" — a different state from any value the shared spec would
 *   default to, and substituting one freezes today's default into the row.
 * - **`profile_media` is a discriminated union** whose CHECK is STRICTER than
 *   the Mongo subschema was, so a half-written item is storable there and
 *   rejected here.
 *
 * Fixtures are `bfu-` prefixed and every cleanup is SCOPED.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  userBehaviorAuthors,
  userBehaviorRegions,
  userBehaviorTopics,
  userBehaviors,
  userSettings,
  userSettingsLabelActions,
} from '../../db/schema/userProfile';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  createResolutionContext,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

/** Scoped to this file — see the header. */
const VIEWER = 'bfu-viewer';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function copy(collection: string) {
  return copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions: createResolutionContext(await planResolutions(source), new ResolutionLog()),
    parents: parentKeysFrom(new Map()),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_user_profile_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  // Both child sets CASCADE from their parent.
  await db.delete(userBehaviors).where(eq(userBehaviors.oxyUserId, VIEWER));
  await db.delete(userSettings).where(eq(userSettings.oxyUserId, VIEWER));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('user behaviors', () => {
  it('keeps the negative signals as arrays and the preferences as rows', async () => {
    const id = new ObjectId();
    await mongo.collection('userbehaviors').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      preferredPostTypes: { text: 5, image: 3, video: 1, poll: 0 },
      activeHours: [9, 10, 21],
      preferredLanguages: ['es', 'en'],
      // Read WHOLE by the ranking context on every For You request — a junction
      // here would turn one row read into four.
      hiddenAuthors: ['bfu-a'],
      mutedAuthors: ['bfu-b'],
      blockedAuthors: ['bfu-c'],
      hiddenTopics: ['bfu-t'],
      skipRate: 0.25,
      completionRate: 0.75,
      preferredAuthors: [
        {
          authorId: 'bfu-author-1',
          interactionCount: 4,
          interactionTypes: { likes: 2, boosts: 1, comments: 1, saves: 0, shares: 0 },
          weight: 0.4,
        },
      ],
    });
    await copy('userbehaviors');

    const [row] = await getDb()
      .select()
      .from(userBehaviors)
      .where(eq(userBehaviors.id, id.toHexString()));

    expect(row?.hiddenAuthors).toStrictEqual(['bfu-a']);
    expect(row?.mutedAuthors).toStrictEqual(['bfu-b']);
    expect(row?.blockedAuthors).toStrictEqual(['bfu-c']);
    expect(row?.hiddenTopics).toStrictEqual(['bfu-t']);
    expect(row?.activeHours).toStrictEqual([9, 10, 21]);
    expect(row?.preferredPostTypeText).toBe(5);
    expect(row?.preferredPostTypePoll).toBe(0);

    const [author] = await getDb()
      .select()
      .from(userBehaviorAuthors)
      .where(eq(userBehaviorAuthors.behaviorId, id.toHexString()));

    // Mongo nested the five counters under `interactionTypes`; each is a plain
    // integer with a known name, so each is a column.
    expect(author?.likes).toBe(2);
    expect(author?.boosts).toBe(1);
    expect(author?.comments).toBe(1);
    expect(author?.saves).toBe(0);
    expect(author?.weight).toBe(0.4);
  });

  it('keeps a region count FRACTIONAL — it is a weight, not a tally', async () => {
    const id = new ObjectId();
    await mongo.collection('userbehaviors').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      preferredRegions: [{ region: 'ES', count: 2.5 }, { region: 'DE', count: 0.25 }],
    });
    await copy('userbehaviors');

    const rows = await getDb()
      .select()
      .from(userBehaviorRegions)
      .where(eq(userBehaviorRegions.behaviorId, id.toHexString()))
      .orderBy(userBehaviorRegions.region);

    // `count` is an accumulated engagement WEIGHT. Reading it with `int` would
    // typecheck, insert, and silently floor every partial accumulation — 0.25
    // would become 0 and the region would stop counting at all.
    expect(rows.map((row) => row.count)).toStrictEqual([0.25, 2.5]);
  });

  it('dedupes each preference array on its own subject', async () => {
    const id = new ObjectId();
    await mongo.collection('userbehaviors').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      preferredAuthors: [
        { authorId: 'bfu-author-1', interactionCount: 9, weight: 0.9 },
        { authorId: 'bfu-author-2', interactionCount: 1, weight: 0.1 },
        { authorId: 'bfu-author-1', interactionCount: 2, weight: 0.2 },
      ],
      preferredTopics: [
        { topic: 'bfu-topic', interactionCount: 3, weight: 0.3 },
        { topic: 'bfu-topic', interactionCount: 7, weight: 0.7 },
      ],
    });
    await copy('userbehaviors');

    const authors = await getDb()
      .select()
      .from(userBehaviorAuthors)
      .where(eq(userBehaviorAuthors.behaviorId, id.toHexString()))
      .orderBy(userBehaviorAuthors.authorId);
    const topics = await getDb()
      .select()
      .from(userBehaviorTopics)
      .where(eq(userBehaviorTopics.behaviorId, id.toHexString()));

    expect(authors.map((row) => row.authorId)).toStrictEqual(['bfu-author-1', 'bfu-author-2']);
    // FIRST occurrence wins. Taking the larger counter instead would be the
    // migration inventing an aggregate nothing ever wrote.
    expect(authors[0]?.interactionCount).toBe(9);
    expect(topics).toHaveLength(1);
    expect(topics[0]?.interactionCount).toBe(3);
  });

  it('carries an ObjectId topicId across as the same hex, or NULL', async () => {
    const id = new ObjectId();
    const topicId = new ObjectId();
    await mongo.collection('userbehaviors').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      preferredTopics: [
        { topic: 'bfu-registered', topicId, weight: 0.5 },
        // Learned before the Topic registry existed — the unique key is the
        // SLUG, so this row is as valid as the one above.
        { topic: 'bfu-unregistered', weight: 0.5 },
      ],
    });
    await copy('userbehaviors');

    const rows = await getDb()
      .select()
      .from(userBehaviorTopics)
      .where(eq(userBehaviorTopics.behaviorId, id.toHexString()))
      .orderBy(userBehaviorTopics.topic);

    expect(rows[0]?.topicId).toBe(topicId.toHexString());
    expect(rows[1]?.topicId).toBeNull();
  });
});

describe('user settings', () => {
  it('flattens five levels of nesting and defaults every absent group', async () => {
    const id = new ObjectId();
    // A settings document written before most of these groups existed — which
    // is the majority shape, not an edge case.
    await mongo.collection('usersettings').insertOne({ _id: id, oxyUserId: VIEWER });
    await copy('usersettings');

    const [row] = await getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.id, id.toHexString()));

    expect(row?.appearanceThemeMode).toBe('system');
    expect(row?.appearancePostTextExpand).toBe('default');
    expect(row?.privacyProfileVisibility).toBe('public');
    // The one default in this plan where being wrong SHOWS someone content they
    // never opted into.
    expect(row?.privacyShowSensitiveContent).toBe(false);
    expect(row?.feedSameAuthorPenalty).toBe(0.95);
    expect(row?.feedRecencyMaxAgeHours).toBe(168);
    expect(row?.notifyPushEnabled).toBe(true);
    expect(row?.notifyEmailEnabled).toBe(false);
  });

  it('leaves feedTuning NULL rather than freezing the shared default into the row', async () => {
    const id = new ObjectId();
    await mongo.collection('usersettings').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      feedTuning: { forYou: { minLength: { enabled: true, minLength: 40 } } },
    });
    await copy('usersettings');

    const [row] = await getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.id, id.toHexString()));

    expect(row?.tuningMinLengthEnabled).toBe(true);
    expect(row?.tuningMinLength).toBe(40);
    // The module the viewer never touched stays NULL. Substituting the shared
    // spec's default would freeze TODAY's value into the row and stop the
    // viewer tracking a later change to it — silently, forever.
    expect(row?.tuningMinQualityEnabled).toBeNull();
    expect(row?.tuningMinQuality).toBeNull();
    expect(row?.tuningMinMeaningfulTextLength).toBeNull();
  });

  it('keeps every embed preference TRI-STATE', async () => {
    const id = new ObjectId();
    await mongo.collection('usersettings').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      externalEmbeds: { youtube: 'show', spotify: 'hide' },
    });
    await copy('usersettings');

    const [row] = await getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.id, id.toHexString()));

    expect(row?.embedYoutube).toBe('show');
    expect(row?.embedSpotify).toBe('hide');
    // Absent means "ask on first play", which is neither. Defaulting it either
    // way answers a consent question on the viewer's behalf — to `show` it
    // silently starts loading third-party players they never allowed.
    expect(row?.embedTwitch).toBeNull();
    expect(row?.embedGiphy).toBeNull();
    expect(row?.embedBandcamp).toBeNull();
  });

  it('audits and copies the SAME ten embed providers', async () => {
    // The structural half of the tri-state property. Two hand-written lists of
    // ten would let a provider be copied but not audited, or audited but not
    // copied, and neither shows up in a row-level assertion: the column just
    // stays NULL, which is also what "nobody set a preference" looks like.
    const plan = planFor('usersettings');
    const auditedColumns = (plan.enumAudits ?? [])
      .map((audit) => audit.column.name)
      .filter((name) => name.startsWith('embed'));
    const embedColumns = getTableConfig(userSettings)
      .columns.map((column) => column.name)
      // Drizzle reports the PROPERTY name here — the snake_case conversion this
      // schema uses happens at DDL/query time, not in `getTableConfig`. Both
      // sides of the comparison read the same field, so the prefix just has to
      // match what drizzle actually stores.
      .filter((name) => name.startsWith('embed'));

    expect(embedColumns).toHaveLength(10);
    expect([...auditedColumns].sort()).toStrictEqual([...embedColumns].sort());
  });

  it('copies a song and REFUSES a half-written one', async () => {
    const complete = new ObjectId();
    await mongo.collection('usersettings').insertOne({
      _id: complete,
      oxyUserId: VIEWER,
      profileCustomization: {
        profileMedia: {
          type: 'song',
          syraTrackId: 'bfu-track',
          title: 'bfu title',
          artist: 'bfu artist',
          previewUrl: 'https://bfu.example/preview.m4a',
          startSec: 12,
        },
      },
    });
    await copy('usersettings');

    const [row] = await getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.id, complete.toHexString()));
    expect(row?.profileMediaType).toBe('song');
    expect(row?.profileMediaSyraTrackId).toBe('bfu-track');
    expect(row?.profileMediaStartSec).toBe(12);
    // The podcast half of the union stays NULL — that mutual exclusion was an
    // emergent property of there being ONE subdocument, and is now a CHECK.
    expect(row?.profileMediaSyraPodcastId).toBeNull();

    await mongo.collection('usersettings').deleteMany({});
    await mongo.collection('usersettings').insertOne({
      _id: new ObjectId(),
      oxyUserId: VIEWER,
      profileCustomization: {
        // `previewUrl` missing. `ProfileMediaSchema` declares it OPTIONAL, so
        // this is storable in Mongo; the CHECK requires it for a song.
        profileMedia: { type: 'song', syraTrackId: 'bfu-track', title: 'bfu title' },
      },
    });

    // Which refusal, not merely that it refused.
    await expect(copy('usersettings')).rejects.toThrow(
      /user_settings_profile_media_shape_check/
    );
    await expect(copy('usersettings')).rejects.toThrow(/db\.usersettings\.countDocuments/);
  });

  it('dedupes label actions on (labeler, slug)', async () => {
    const id = new ObjectId();
    await mongo.collection('usersettings').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      privacy: {
        labelPreferences: {
          subscribedLabelers: ['bfu-labeler-1'],
          labelActions: [
            { labelerId: 'bfu-labeler-1', labelSlug: 'bfu-a', action: 'hide' },
            { labelerId: 'bfu-labeler-2', labelSlug: 'bfu-a', action: 'warn' },
            // Same pair as the first — the embedded array permits it and the
            // unique key does not.
            { labelerId: 'bfu-labeler-1', labelSlug: 'bfu-a', action: 'show' },
          ],
        },
      },
    });
    await copy('usersettings');

    const rows = await getDb()
      .select()
      .from(userSettingsLabelActions)
      .where(eq(userSettingsLabelActions.settingsId, id.toHexString()))
      .orderBy(userSettingsLabelActions.labelerId);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe('hide');
    expect(rows[1]?.labelerId).toBe('bfu-labeler-2');
    // The DIFFERENT labeler with the SAME slug survives — deduping on the slug
    // alone would silently drop one viewer preference per shared label name.
    expect(rows.map((row) => row.labelSlug)).toStrictEqual(['bfu-a', 'bfu-a']);

    const [settings] = await getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.id, id.toHexString()));
    expect(settings?.privacySubscribedLabelers).toStrictEqual(['bfu-labeler-1']);
  });
});
