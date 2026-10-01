/**
 * The owned-cluster guards behind scripts/test-jev-owned-pg.sh.
 *
 * No database, no network. postgres-js resolves its options at construction and
 * connects only on the first query, so every client below is built, inspected
 * and ended without a query; the socket directory named here does not exist.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
  REQUIRED_ENV,
  assertHostlessUrl,
  assertOwnedClientOptions,
  assertServerIdentity,
  createVerifiedClient,
  maintenanceUrlOf,
  ownedPgEnv,
  ownedUrl,
  readOwnedIdentity,
  verifyOwnedCluster,
} from '../../../../scripts/lib/jevOwnedPg.mjs';

const ROOT = '/tmp/jev-owned-unit-no-such-cluster';
const ENV = {
  JEV_TEST_DATA: `${ROOT}/data`,
  JEV_TEST_SOCKET: `${ROOT}/socket`,
  JEV_TEST_PORT: '5432',
  JEV_TEST_DATABASE: 'mention_jev_owned_base',
  JEV_TEST_USER: 'nate',
};
const identity = readOwnedIdentity(ENV);
const SOCKET_PATH = `${ROOT}/socket/.s.PGSQL.5432`;

function stubOwnedPgEnv(): void {
  for (const [name, value] of Object.entries(ownedPgEnv(identity))) vi.stubEnv(name, value);
  vi.stubEnv('PGDATABASE', undefined);
}

function clearPgEnv(): void {
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGUSERNAME', 'PGDATABASE']) vi.stubEnv(name, undefined);
}

/** A postgres-js factory that records every construction. */
function recordingFactory() {
  const built: ReturnType<typeof postgres>[] = [];
  const factory = vi.fn((url: string, options: postgres.Options<Record<string, never>>) => {
    const client = postgres(url, options);
    built.push(client);
    return client;
  });
  return { factory, built };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('postgres');
  vi.resetModules();
});

describe('readOwnedIdentity', () => {
  it.each(REQUIRED_ENV)('refuses when %s is missing, before any client exists', async (name) => {
    const { factory } = recordingFactory();
    const env = { ...ENV, [name]: '' };
    await expect(async () => {
      const id = readOwnedIdentity(env);
      await createVerifiedClient(factory, id, ownedUrl(id.database));
    }).rejects.toThrow(new RegExp(`unset: .*${name}`));
    expect(factory).not.toHaveBeenCalled();
  });

  it('names every missing variable at once', () => {
    expect(() => readOwnedIdentity({})).toThrow(REQUIRED_ENV.join(', '));
  });

  it.each([
    ['JEV_TEST_DATA', 'tmp/relative/data', /absolute/],
    ['JEV_TEST_DATA', '/var/lib/postgresql/data', /under \/tmp/],
    ['JEV_TEST_DATA', '/tmp/x/../etc', /normalized/],
    ['JEV_TEST_SOCKET', '/tmp/x/socket/', /normalized/],
    ['JEV_TEST_SOCKET', '/var/run/postgresql', /under \/tmp/],
    ['JEV_TEST_PORT', '5432x', /integer port/],
    ['JEV_TEST_PORT', '70000', /integer port/],
    ['JEV_TEST_DATABASE', 'postgres', /non-system/],
    ['JEV_TEST_DATABASE', 'template1', /non-system/],
    ['JEV_TEST_DATABASE', 'db;drop', /non-system/],
    ['JEV_TEST_USER', 'nate@host', /plain role/],
  ])('refuses %s=%s', (name, value, message) => {
    expect(() => readOwnedIdentity({ ...ENV, [name]: value })).toThrow(message);
  });

  it('refuses the same directory for data and socket', () => {
    expect(() => readOwnedIdentity({ ...ENV, JEV_TEST_SOCKET: ENV.JEV_TEST_DATA })).toThrow(/different/);
  });
});

describe('assertHostlessUrl', () => {
  it('accepts the hostless owned url and returns its database', () => {
    expect(ownedUrl('mention_jev_owned_base')).toBe('postgres:///mention_jev_owned_base');
    expect(assertHostlessUrl('postgres:///mention_jev_owned_base')).toBe('mention_jev_owned_base');
  });

  it.each([
    ['postgres://localhost/mention_jev_owned_base', /with a host/],
    ['postgres://127.0.0.1:5432/mention_jev_owned_base', /with a host/],
    ['postgres://localhost/mention_jev_owned_base?host=/tmp/jev/socket', /with a host/],
    ['postgres:///mention_jev_owned_base?host=/tmp/jev/socket', /\?host=/],
    ['postgres:///mention_jev_owned_base?port=5433', /\?port=/],
    ['postgres:///mention_jev_owned_base?dbname=other', /\?dbname=/],
    ['postgres://nate:pw@localhost/mention_jev_owned_base', /with a host/],
    ['mysql:///mention_jev_owned_base', /protocol/],
    ['postgres:///', /plain database name/],
    ['not a url', /unparseable/],
  ])('refuses %s', (url, message) => {
    expect(() => assertHostlessUrl(url)).toThrow(message);
  });
});

describe('postgres-js lazy options', () => {
  it('resolve the hostless named base to the owned socket, port, role and database', async () => {
    stubOwnedPgEnv();
    const { factory, built } = recordingFactory();
    const client = await createVerifiedClient(factory, identity, ownedUrl(identity.database));
    expect(client.options).toMatchObject({
      host: [identity.socket],
      port: [5432],
      path: SOCKET_PATH,
      user: 'nate',
      database: 'mention_jev_owned_base',
    });
    expect(built).toHaveLength(1);
    await client.end({ timeout: 0 });
  });

  it('resolve the maintenance database @oxy.so/db/testing actually rewrites to, on the same socket', async () => {
    stubOwnedPgEnv();
    const seen: string[] = [];
    // Capture the url the shared harness hands postgres-js, then stop it before
    // it can issue CREATE DATABASE.
    vi.doMock('postgres', () => ({
      default: (url: string) => {
        seen.push(url);
        return {
          unsafe: async () => {
            throw new Error('stopped before query');
          },
          end: async () => undefined,
        };
      },
    }));
    const { createTestDatabase } = await import('@oxy.so/db/testing');
    await expect(createTestDatabase({ adminUrl: ownedUrl(identity.database) })).rejects.toThrow('stopped before query');

    expect(seen).toEqual(['postgres:///postgres']);
    expect(maintenanceUrlOf(ownedUrl(identity.database))).toBe(seen[0]);

    const { factory } = recordingFactory();
    const client = await createVerifiedClient(factory, identity, seen[0]);
    expect(client.options).toMatchObject({
      host: [identity.socket],
      port: [5432],
      path: SOCKET_PATH,
      user: 'nate',
      database: 'postgres',
    });
    await client.end({ timeout: 0 });
  });

  it('refuse the default localhost fallback when PGHOST is unset', async () => {
    clearPgEnv();
    const { factory, built } = recordingFactory();
    await expect(createVerifiedClient(factory, identity, ownedUrl(identity.database))).rejects.toThrow(/localhost/);
    expect(built[0].options.host).toEqual(['localhost']);
  });

  it('refuse a PGHOST pointing at a different socket', async () => {
    stubOwnedPgEnv();
    vi.stubEnv('PGHOST', '/tmp/someone-elses-cluster/socket');
    const { factory } = recordingFactory();
    await expect(createVerifiedClient(factory, identity, ownedUrl(identity.database))).rejects.toThrow(/someone-elses/);
  });

  it('refuse a role other than JEV_TEST_USER, including a stray PGUSERNAME', async () => {
    stubOwnedPgEnv();
    vi.stubEnv('PGUSERNAME', 'postgres');
    const { factory } = recordingFactory();
    await expect(createVerifiedClient(factory, identity, ownedUrl(identity.database))).rejects.toThrow(/"user":"postgres"/);
  });

  it('show the ?host trap: a hostname url ignores the socket parameter and goes to TCP', () => {
    stubOwnedPgEnv();
    const client = postgres(`postgres://localhost/mention_jev_owned_base?host=${identity.socket}`, { max: 1 });
    expect(client.options.host).toEqual(['localhost']);
    expect(client.options.path).toBe(false);
    expect(() => assertOwnedClientOptions(client.options, identity, 'mention_jev_owned_base')).toThrow(/localhost/);
    void client.end({ timeout: 0 });
  });

  it('refuse the ?host trap and localhost urls before constructing a client', async () => {
    stubOwnedPgEnv();
    const { factory } = recordingFactory();
    for (const url of [
      `postgres://localhost/mention_jev_owned_base?host=${identity.socket}`,
      'postgres://localhost/mention_jev_owned_base',
      `postgres:///mention_jev_owned_base?host=${identity.socket}`,
    ]) {
      await expect(createVerifiedClient(factory, identity, url)).rejects.toThrow(/Refusing/);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('refuse any database but the named base and its maintenance database', async () => {
    stubOwnedPgEnv();
    const { factory } = recordingFactory();
    await expect(createVerifiedClient(factory, identity, ownedUrl('mention'))).rejects.toThrow(/only mention_jev_owned_base/);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('assertServerIdentity', () => {
  it('accepts the exact data directory with TCP disabled', () => {
    expect(() => assertServerIdentity(identity, identity.data, '')).not.toThrow();
  });

  it.each([
    ['/var/lib/postgresql/16/main', '', /data_directory/],
    [`${ROOT}/data`, 'localhost', /TCP/],
    [`${ROOT}/data`, '*', /TCP/],
  ])('refuses data_directory=%s listen_addresses=%s', (data, listen, message) => {
    expect(() => assertServerIdentity(identity, data, listen)).toThrow(message);
  });
});

describe('verifyOwnedCluster', () => {
  const PID = 4242;
  const pidFile = (overrides: Partial<Record<number, string>> = {}) => {
    const lines = [String(PID), identity.data, '1790000000', '5432', identity.socket, '', '  5432001  0', 'ready'];
    for (const [index, value] of Object.entries(overrides)) lines[Number(index)] = value as string;
    return `${lines.join('\n')}\n`;
  };
  const probe = (overrides: Record<string, unknown> = {}) => ({
    realpath: (p: string) => p,
    isDirectory: () => true,
    isSocket: (p: string) => p === SOCKET_PATH,
    readFile: (p: string) => (p.endsWith('postmaster.pid') ? pidFile() : `${PID}\n${identity.data}\n`),
    isAlive: (pid: number) => pid === PID,
    comm: () => 'postgres',
    ...overrides,
  });

  it('returns the postmaster PID when every check holds', () => {
    expect(verifyOwnedCluster(identity, probe())).toBe(PID);
  });

  it.each([
    ['a missing data directory', { isDirectory: (p: string) => p !== identity.data }, /not an existing directory/],
    ['a symlinked socket directory', { realpath: (p: string) => (p === identity.socket ? '/var/run/postgresql' : p) }, /resolves elsewhere/],
    ['a foreign data directory in postmaster.pid', { readFile: () => pidFile({ 1: '/var/lib/postgresql/data' }) }, /data directory/],
    ['a different port', { readFile: () => pidFile({ 3: '5433' }) }, /port 5433/],
    ['a different socket directory', { readFile: () => pidFile({ 4: '/var/run/postgresql' }) }, /socket directory/],
    ['a TCP listener', { readFile: () => pidFile({ 5: '127.0.0.1' }) }, /TCP must be disabled/],
    ['a dead postmaster', { isAlive: () => false }, /not running/],
    ['a recycled PID', { comm: () => 'bash' }, /not a postgres postmaster/],
    ['a missing socket file', { isSocket: () => false }, /not a Unix socket/],
    ['a socket lock held by another process', {
      readFile: (p: string) => (p.endsWith('postmaster.pid') ? pidFile() : '9999\n'),
    }, /held by PID 9999/],
  ])('refuses %s', (_label, overrides, message) => {
    expect(() => verifyOwnedCluster(identity, probe(overrides))).toThrow(message);
  });
});
