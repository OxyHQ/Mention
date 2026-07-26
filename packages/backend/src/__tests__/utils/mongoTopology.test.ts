import type mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import {
  assertMongoTransactionalTopology,
  MongoTransactionalTopologyError,
} from '../../utils/mongoTopology';

function databaseWithHello(response: Record<string, unknown>) {
  const command = vi.fn().mockResolvedValue(response);
  const database = {
    admin: () => ({ command }),
  } as unknown as Pick<mongoose.mongo.Db, 'admin'>;
  return { command, database };
}

describe('assertMongoTransactionalTopology', () => {
  it('fails closed when no database connection is active', async () => {
    await expect(assertMongoTransactionalTopology(null)).rejects.toMatchObject({
      name: 'MongoTransactionalTopologyError',
      code: 'MONGO_TRANSACTIONAL_TOPOLOGY_REQUIRED',
    });
  });

  it('wraps hello command failures without leaking connection details', async () => {
    const database = {
      admin: () => ({
        command: vi.fn().mockRejectedValue(
          new Error('mongodb://user:password@private-host.internal/mention'),
        ),
      }),
    } as unknown as Pick<mongoose.mongo.Db, 'admin'>;

    const result = assertMongoTransactionalTopology(database);
    await expect(result).rejects.toThrow('Could not verify MongoDB transaction support');
    await expect(result).rejects.not.toThrow(/private-host|password|mongodb:\/\//i);
  });

  it('rejects a standalone server with an operational message and no URI', async () => {
    const { command, database } = databaseWithHello({
      ok: 1,
      isWritablePrimary: true,
    });

    const result = assertMongoTransactionalTopology(database);

    await expect(result).rejects.toBeInstanceOf(MongoTransactionalTopologyError);
    await expect(result).rejects.toThrow(
      'Multi-document transactions require a replica set or mongos',
    );
    await expect(result).rejects.not.toThrow(/mongodb(?:\+srv)?:\/\//i);
    expect(command).toHaveBeenCalledWith({ hello: 1 });
  });

  it('accepts a replica set', async () => {
    const { database } = databaseWithHello({
      ok: 1,
      setName: 'production-rs',
      isWritablePrimary: true,
    });

    await expect(assertMongoTransactionalTopology(database)).resolves.toBe('replica_set');
  });

  it('accepts mongos', async () => {
    const { database } = databaseWithHello({
      ok: 1,
      msg: 'isdbgrid',
    });

    await expect(assertMongoTransactionalTopology(database)).resolves.toBe('mongos');
  });

  it.each([
    { setName: '' },
    { setName: '   ' },
    { setName: 42 },
  ])('does not treat an invalid replica-set name as transactional: %j', async (hello) => {
    const { database } = databaseWithHello(hello);
    await expect(assertMongoTransactionalTopology(database)).rejects.toThrow(
      'MongoDB standalone topology detected',
    );
  });
});
