/**
 * Guards for the Jev suite's OWNED synthetic PostgreSQL cluster.
 *
 * Every function here is pure, or takes its filesystem and process probes as
 * arguments, so the refusals can be unit-tested without a database or network.
 * `scripts/test-jev-owned-pg.sh` calls them in this order, and nothing opens a
 * connection until all of them have passed:
 *
 *   1. readOwnedIdentity   the five JEV_TEST_* variables, explicit and well formed
 *   2. verifyOwnedCluster  postmaster.pid, the live postmaster, the socket file
 *   3. ownedUrl            a HOSTLESS url, so postgres-js resolves PGHOST
 *   4. createVerifiedClient postgres-js's own lazy options, checked before any query
 *
 * Why hostless: postgres-js 3.4 uses PGHOST only when the url hostname is empty.
 * `postgres://localhost/db?host=/sock` connects to TCP localhost and ignores the
 * query parameter, and a hostless url with PGHOST unset falls back to localhost
 * too. Either mistake reaches whatever cluster listens on localhost:5432, so the
 * url guard refuses any hostname or connection-routing parameter outright and the
 * options check refuses anything but the owned socket.
 */

import path from 'node:path';

export const REQUIRED_ENV = Object.freeze([
  'JEV_TEST_DATA',
  'JEV_TEST_SOCKET',
  'JEV_TEST_PORT',
  'JEV_TEST_DATABASE',
  'JEV_TEST_USER',
]);

/** The database `@oxy.so/db/testing` rewrites to for CREATE/DROP DATABASE. */
export const MAINTENANCE_DATABASE = 'postgres';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED_BASE_DATABASES = new Set([MAINTENANCE_DATABASE, 'template0', 'template1']);
const ROUTING_PARAMS = [
  'host',
  'hostaddr',
  'port',
  'user',
  'username',
  'password',
  'dbname',
  'database',
  'service',
  'sslmode',
];

function ownedTmpPath(name, value) {
  if (!path.isAbsolute(value))
    throw new Error(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
  if (path.normalize(value) !== value || value.endsWith('/')) {
    throw new Error(
      `${name} must be a normalized path with no "..", "." or trailing slash: ${value}`,
    );
  }
  if (!value.startsWith('/tmp/') || value === '/tmp/')
    throw new Error(`${name} must live under /tmp/: ${value}`);
  return value;
}

/**
 * Read and validate the owned cluster's identity. Throws before anything else
 * runs when any variable is missing or malformed; there are no defaults.
 */
export function readOwnedIdentity(env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to run: required owned-cluster variables are unset: ${missing.join(', ')}`,
    );
  }
  const data = ownedTmpPath('JEV_TEST_DATA', env.JEV_TEST_DATA);
  const socket = ownedTmpPath('JEV_TEST_SOCKET', env.JEV_TEST_SOCKET);
  if (data === socket)
    throw new Error('JEV_TEST_DATA and JEV_TEST_SOCKET must be different directories');
  if (!/^[1-9][0-9]{0,4}$/.test(env.JEV_TEST_PORT) || Number(env.JEV_TEST_PORT) > 65535) {
    throw new Error(
      `JEV_TEST_PORT must be an integer port, got ${JSON.stringify(env.JEV_TEST_PORT)}`,
    );
  }
  const database = env.JEV_TEST_DATABASE;
  if (!IDENTIFIER.test(database) || RESERVED_BASE_DATABASES.has(database)) {
    throw new Error(
      `JEV_TEST_DATABASE must be a named, non-system database, got ${JSON.stringify(database)}`,
    );
  }
  const user = env.JEV_TEST_USER;
  if (!IDENTIFIER.test(user))
    throw new Error(`JEV_TEST_USER must be a plain role name, got ${JSON.stringify(user)}`);
  return Object.freeze({ data, socket, port: Number(env.JEV_TEST_PORT), database, user });
}

/** The only connection string the runner publishes. */
export function ownedUrl(database) {
  if (!IDENTIFIER.test(database))
    throw new Error(`Not a plain database name: ${JSON.stringify(database)}`);
  return `postgres:///${database}`;
}

/** The PG* routing variables postgres-js reads, all pointing at the owned socket. */
export function ownedPgEnv(identity) {
  return {
    PGHOST: identity.socket,
    PGPORT: String(identity.port),
    PGUSER: identity.user,
    // postgres-js prefers PGUSERNAME over PGUSER, so pin both.
    PGUSERNAME: identity.user,
  };
}

/**
 * Refuse any url that could route somewhere other than PGHOST: a hostname
 * (including localhost), an explicit port or credentials, or a routing query
 * parameter. Returns the database name the url selects.
 */
export function assertHostlessUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Refusing an unparseable database url');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`Refusing database url with protocol ${parsed.protocol}`);
  }
  if (parsed.hostname !== '' || parsed.port !== '') {
    throw new Error(
      `Refusing database url with a host (${parsed.hostname || parsed.port}); only hostless urls resolve PGHOST`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Refusing database url carrying credentials; the role comes from PGUSER');
  }
  for (const param of ROUTING_PARAMS) {
    if (parsed.searchParams.has(param)) {
      throw new Error(
        `Refusing database url with ?${param}=; postgres-js does not route a hostname url through it`,
      );
    }
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!IDENTIFIER.test(database))
    throw new Error(
      `Refusing database url without a plain database name: ${JSON.stringify(database)}`,
    );
  return database;
}

/** Mirror of `@oxy.so/db/testing`'s maintenanceUrl; the unit suite proves they agree. */
export function maintenanceUrlOf(url) {
  const parsed = new URL(url);
  parsed.pathname = `/${MAINTENANCE_DATABASE}`;
  return parsed.toString();
}

/**
 * Assert a postgres-js client's resolved options name exactly the owned socket,
 * port, role and database. postgres-js resolves these at construction and opens
 * no connection until the first query, so this runs before any network I/O.
 */
export function assertOwnedClientOptions(options, identity, database) {
  const expected = {
    host: [identity.socket],
    port: [identity.port],
    path: `${identity.socket}/.s.PGSQL.${identity.port}`,
    user: identity.user,
    database,
  };
  const actual = {
    host: options.host,
    port: options.port,
    path: options.path,
    user: options.user,
    database: options.database,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `postgres-js resolved ${JSON.stringify(actual)}, expected the owned cluster ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Construct a client through `factory` (postgres-js's default export) only after
 * the url passes the hostless guard and the database is one this run may use,
 * then check its lazy options. On a mismatch the client is ended unused.
 */
export async function createVerifiedClient(factory, identity, url, clientOptions = {}) {
  const database = assertHostlessUrl(url);
  if (database !== identity.database && database !== MAINTENANCE_DATABASE) {
    throw new Error(
      `Refusing database ${database}: only ${identity.database} and its maintenance database are authorized`,
    );
  }
  const client = factory(url, { max: 1, connect_timeout: 5, fetch_types: false, ...clientOptions });
  try {
    assertOwnedClientOptions(client.options, identity, database);
  } catch (error) {
    await client.end({ timeout: 0 });
    throw error;
  }
  return client;
}

/** Assert SHOW data_directory / listen_addresses answers from the same client. */
export function assertServerIdentity(identity, dataDirectory, listenAddresses) {
  if (dataDirectory !== identity.data) {
    throw new Error(
      `Connected server's data_directory is ${dataDirectory}, expected ${identity.data}`,
    );
  }
  if (listenAddresses !== '') {
    throw new Error(
      `Connected server listens on TCP (${listenAddresses}); the owned cluster must have TCP disabled`,
    );
  }
}

/**
 * Check the owned cluster on disk before any client exists: real (non-symlinked)
 * directories, a postmaster.pid naming this data directory, port and socket
 * directory with no TCP listener, a live process called postgres, and the socket
 * file plus its lock owned by that same postmaster.
 *
 * `probe` supplies { realpath, isDirectory, isSocket, readFile, isAlive, comm }.
 */
export function verifyOwnedCluster(identity, probe) {
  for (const [name, dir] of [
    ['JEV_TEST_DATA', identity.data],
    ['JEV_TEST_SOCKET', identity.socket],
  ]) {
    if (!probe.isDirectory(dir)) throw new Error(`${name} ${dir} is not an existing directory`);
    if (probe.realpath(dir) !== dir)
      throw new Error(`${name} ${dir} resolves elsewhere (${probe.realpath(dir)})`);
  }
  // postmaster.pid lines: pid, data dir, start time, port, socket dir, first
  // listen address (empty when no TCP port), shmem key, status.
  const pidLines = probe.readFile(path.join(identity.data, 'postmaster.pid')).split('\n');
  const pid = Number(pidLines[0]);
  if (!Number.isInteger(pid) || pid <= 1)
    throw new Error(`postmaster.pid holds no usable PID (${JSON.stringify(pidLines[0])})`);
  if (pidLines[1] !== identity.data)
    throw new Error(
      `postmaster.pid names data directory ${pidLines[1]}, expected ${identity.data}`,
    );
  if (Number(pidLines[3]) !== identity.port)
    throw new Error(`postmaster.pid names port ${pidLines[3]}, expected ${identity.port}`);
  if (pidLines[4] !== identity.socket)
    throw new Error(
      `postmaster.pid names socket directory ${pidLines[4]}, expected ${identity.socket}`,
    );
  if (pidLines[5] !== '')
    throw new Error(
      `postmaster.pid records TCP listen address ${JSON.stringify(pidLines[5])}; TCP must be disabled`,
    );
  if (!probe.isAlive(pid)) throw new Error(`postmaster PID ${pid} is not running`);
  if (probe.comm(pid) !== 'postgres')
    throw new Error(`PID ${pid} is ${JSON.stringify(probe.comm(pid))}, not a postgres postmaster`);
  const socketFile = path.join(identity.socket, `.s.PGSQL.${identity.port}`);
  if (!probe.isSocket(socketFile)) throw new Error(`${socketFile} is not a Unix socket`);
  const lockPid = Number(probe.readFile(`${socketFile}.lock`).split('\n')[0]);
  if (lockPid !== pid)
    throw new Error(`${socketFile}.lock is held by PID ${lockPid}, not postmaster ${pid}`);
  return pid;
}

/** The real filesystem/process probe for verifyOwnedCluster (Linux). */
export async function systemProbe() {
  const fs = await import('node:fs');
  const stat = (p) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return undefined;
    }
  };
  return {
    realpath: (p) => fs.realpathSync(p),
    isDirectory: (p) => stat(p)?.isDirectory() === true,
    isSocket: (p) => stat(p)?.isSocket() === true,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    comm: (pid) => fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
  };
}
