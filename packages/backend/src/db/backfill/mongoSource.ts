/**
 * Read-only access to the source MongoDB.
 *
 * ## "It must never write to Mongo" is a CONTROL here, not a promise
 *
 * Production Mongo stays live serving the app throughout the cutover, so a
 * stray write from the migration is the one failure that cannot be rolled back
 * by dropping the Postgres database and starting again. A comment saying "we
 * only read" is worth nothing: the driver's write methods are on the same
 * object as its read methods, one keystroke apart (`findOne` /
 * `findOneAndUpdate`), and nothing would fail if one were called.
 *
 * {@link readOnlyCollection} therefore hands out a Proxy that resolves only the
 * methods on {@link READ_METHODS} and THROWS on everything else — including
 * methods that do not exist yet, since the allowlist is closed rather than a
 * denylist of today's write methods. A future driver version adding
 * `replaceOneWithSomething` is refused by construction.
 *
 * ## Cursor discipline
 *
 * Documents stream in `_id` order with an explicit batch size and
 * `noCursorTimeout` left OFF. Ordering by `_id` is what makes the copy
 * resumable: the checkpoint is the last `_id` committed, and the next run
 * restarts from `_id > checkpoint` rather than re-reading the whole `posts`
 * collection.
 */

import mongoose, { type mongo } from 'mongoose';
import { isObjectId, type MongoDocument } from './values';

/**
 * Driver types are taken from `mongoose`'s own `mongo` re-export, NEVER by
 * importing `mongodb` directly.
 *
 * Which `mongodb` a bare `import type { Db } from 'mongodb'` resolves to is a
 * property of the installed tree, not of this file: the runtime values here all
 * come from mongoose's own nested copy, so typing them against whatever version
 * happens to hoist compiles (the shapes are similar enough) and is wrong. Going
 * through `mongoose.mongo` resolves the same copy the values come from, by
 * construction.
 */
type DriverDb = mongo.Db;

/**
 * A source document, with the `_id` type this migration actually faces.
 *
 * The driver's default `Document` schema implies `_id: ObjectId`, so
 * `Filter<Document>` REFUSES `{_id: {$gt: someString}}`. Mention's collections
 * are overwhelmingly ObjectId-keyed, but the migration ledger (`migrations`,
 * `_id` = the migration id string) and its lease (`migration_leases`, `_id` =
 * `'global'`) are not — and even though both are excluded from the copy, the
 * discovery phase still counts them through this same handle. Declaring the
 * union here is the same fact {@link Checkpoint} carries at runtime, stated
 * once at the type level so the resume filter is expressible without a cast.
 */
interface SourceDocument {
  readonly _id: mongo.ObjectId | string;
  readonly [key: string]: unknown;
}

type DriverCollection = mongo.Collection<SourceDocument>;

/**
 * The only collection methods the backfill may call.
 *
 * A closed allowlist, not a denylist: anything absent is refused, so a driver
 * upgrade cannot widen it silently.
 */
export const READ_METHODS: readonly string[] = [
  'find',
  'findOne',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'aggregate',
  'indexes',
  'listIndexes',
];

/** Raised when the backfill attempts anything that is not a read. */
export class MongoWriteAttemptError extends Error {
  constructor(collection: string, method: string) {
    super(
      `Refused to call ${collection}.${method}() — the backfill has read-only ` +
        'access to MongoDB by construction. Production Mongo stays live during ' +
        `the cutover; only ${READ_METHODS.join(', ')} are permitted.`
    );
    this.name = 'MongoWriteAttemptError';
  }
}

/** The read-only surface a plan's source is reached through. */
export type ReadOnlyCollection = Pick<
  DriverCollection,
  'find' | 'countDocuments' | 'estimatedDocumentCount' | 'distinct' | 'aggregate'
>;

/**
 * Wrap a driver collection so only {@link READ_METHODS} resolve.
 *
 * Anything else throws {@link MongoWriteAttemptError} at ACCESS time — before
 * the call — so even taking a reference to `collection.deleteMany` fails.
 */
export function readOnlyCollection(collection: DriverCollection): ReadOnlyCollection {
  const name = collection.collectionName;
  return new Proxy(collection, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver);
      if (property === 'collectionName') return name;
      if (!READ_METHODS.includes(property)) {
        throw new MongoWriteAttemptError(name, property);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as ReadOnlyCollection;
}

/** The source database, connected read-only-by-construction. */
export interface MongoSource {
  /** Live collection names, from `db.listCollections()`. */
  listCollections(): Promise<string[]>;
  /** A read-only handle on one collection. */
  collection(name: string): ReadOnlyCollection;
  /** Document count, or 0 when the collection does not exist. */
  count(name: string): Promise<number>;
  /** Close the connection. */
  close(): Promise<void>;
}

/**
 * Build a read-only source over an already-open driver `Db`.
 *
 * Split out from {@link connectMongoSource} so a test can drive a REAL MongoDB
 * without going through mongoose — `src/__tests__/setup.ts` mocks mongoose
 * wholesale for the whole suite, and a fake in-memory source would mean the
 * audits were testing an invented `$group`/`$toLower`/`distinct` rather than
 * Mongo's.
 *
 * @param db An open database handle.
 * @param close Called by {@link MongoSource.close}; the caller owns the
 *   connection's lifetime because it owns its creation.
 */
export function mongoSourceFromDb(db: DriverDb, close: () => Promise<void>): MongoSource {
  const existing = new Set<string>();
  let listed = false;

  async function listCollections(): Promise<string[]> {
    if (!listed) {
      const infos = await db.listCollections({}, { nameOnly: true }).toArray();
      for (const info of infos) existing.add(info.name);
      listed = true;
    }
    return [...existing].sort();
  }

  return {
    listCollections,
    collection(name) {
      return readOnlyCollection(db.collection<SourceDocument>(name));
    },
    async count(name) {
      const names = await listCollections();
      if (!names.includes(name)) return 0;
      return db.collection<SourceDocument>(name).countDocuments({});
    },
    close,
  };
}

/**
 * Connect to the source MongoDB.
 *
 * Uses a DEDICATED mongoose connection rather than the default one, so nothing
 * else in the process can pick it up by importing a model and issuing a write
 * through it — every model in `src/models/` is bound to the default connection.
 */
export async function connectMongoSource(uri: string): Promise<MongoSource> {
  const connection = await mongoose
    .createConnection(uri, {
      // A backfill reads large batches from few cursors; the default pool is
      // sized for a request-serving process.
      maxPoolSize: 4,
      serverSelectionTimeoutMS: 15_000,
    })
    .asPromise();

  const db = connection.db;
  if (!db) {
    throw new Error(`Connected to ${redactUri(uri)} but no database was selected`);
  }

  return mongoSourceFromDb(db, async () => {
    await connection.close();
  });
}

/** A connection string with its credentials removed, for logs. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
}

/**
 * A resume position: the last `_id` a run committed, WITH its BSON type.
 *
 * The type is stored, never inferred. A "looks like 24 hex characters ⇒
 * ObjectId" rule is unsafe in both directions, and `{$gt: ObjectId(...)}`
 * against a string `_id` matches NOTHING in Mongo — silently. A resumed run
 * would report "0 documents remaining" and be believed.
 */
export interface Checkpoint {
  /** The `_id` rendered as a string. */
  readonly value: string;
  /** What it was in BSON. */
  readonly kind: 'objectId' | 'string';
}

/** The checkpoint a document represents, with its type read from the value. */
export function checkpointOf(doc: MongoDocument): Checkpoint {
  const raw = doc._id;
  if (isObjectId(raw)) return { value: raw.toHexString(), kind: 'objectId' };
  if (typeof raw === 'string') return { value: raw, kind: 'string' };
  throw new Error(
    `Document _id is neither an ObjectId nor a string (${typeof raw}); the ` +
      'backfill cannot form a resume checkpoint for it'
  );
}

/**
 * Turn a checkpoint back into the `_id` value the driver must compare against.
 *
 * Detection is duck-typed ({@link isObjectId}) but CONSTRUCTION has to produce
 * an instance the driver serializes as a BSON ObjectId, so it goes through
 * `mongoose.Types.ObjectId` — the same `bson` copy mongoose's own driver uses.
 */
export function reviveCheckpoint(checkpoint: Checkpoint): mongo.ObjectId | string {
  return checkpoint.kind === 'objectId'
    ? new mongoose.Types.ObjectId(checkpoint.value)
    : checkpoint.value;
}

/**
 * Stream a collection in `_id` order, in batches, from an optional checkpoint.
 *
 * `after` is the last `_id` a previous run committed. Restarting from
 * `_id > after` is what makes the copy resumable without re-reading everything
 * — and it is safe to get wrong in the conservative direction, because every
 * insert is `ON CONFLICT DO NOTHING` and a re-read is merely slower.
 */
export async function* streamCollection(
  source: MongoSource,
  name: string,
  batchSize: number,
  after?: Checkpoint
): AsyncGenerator<MongoDocument[]> {
  const filter = after === undefined ? {} : { _id: { $gt: reviveCheckpoint(after) } };
  const cursor = source
    .collection(name)
    .find(filter, { sort: { _id: 1 }, batchSize })
    .batchSize(batchSize);

  let batch: MongoDocument[] = [];
  for await (const doc of cursor) {
    batch.push(doc as MongoDocument);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}
