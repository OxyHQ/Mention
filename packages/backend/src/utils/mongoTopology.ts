import mongoose from 'mongoose';

export type MongoTransactionalTopology = 'replica_set' | 'mongos';

export class MongoTransactionalTopologyError extends Error {
  readonly code = 'MONGO_TRANSACTIONAL_TOPOLOGY_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'MongoTransactionalTopologyError';
  }
}

type MongoTopologyDatabase = Pick<mongoose.mongo.Db, 'admin'>;

interface MongoHelloResponse {
  msg?: unknown;
  setName?: unknown;
}

/**
 * Verify that the connected Mongo deployment supports multi-document
 * transactions. The probe intentionally returns only a topology class and all
 * failure messages omit hosts, credentials, and connection URIs.
 */
export async function assertMongoTransactionalTopology(
  database: MongoTopologyDatabase | null | undefined = mongoose.connection.db,
): Promise<MongoTransactionalTopology> {
  if (!database) {
    throw new MongoTransactionalTopologyError(
      'Cannot verify MongoDB transaction support because there is no active database connection. Deployment stopped before migrations.',
    );
  }

  let hello: MongoHelloResponse;
  try {
    hello = await database.admin().command({ hello: 1 });
  } catch {
    throw new MongoTransactionalTopologyError(
      'Could not verify MongoDB transaction support with the hello command. Deployment stopped before migrations; check database reachability and command permissions.',
    );
  }

  if (hello.msg === 'isdbgrid') {
    return 'mongos';
  }
  if (typeof hello.setName === 'string' && hello.setName.trim().length > 0) {
    return 'replica_set';
  }

  throw new MongoTransactionalTopologyError(
    'MongoDB standalone topology detected. Multi-document transactions require a replica set or mongos. Deployment stopped before migrations; convert the database topology before retrying.',
  );
}
