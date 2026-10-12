/**
 * Prove the owned cluster before the Jev suite runs. Invoked by
 * scripts/test-jev-owned-pg.sh with the PG* variables already exported from the
 * JEV_TEST_* identity. Exits non-zero, before any query, on the first mismatch.
 */

import postgres from 'postgres';
import {
  MAINTENANCE_DATABASE,
  assertServerIdentity,
  createVerifiedClient,
  maintenanceUrlOf,
  ownedPgEnv,
  ownedUrl,
  readOwnedIdentity,
  systemProbe,
  verifyOwnedCluster,
} from './jevOwnedPg.mjs';

const identity = readOwnedIdentity(process.env);
for (const [name, value] of Object.entries(ownedPgEnv(identity))) {
  if (process.env[name] !== value)
    throw new Error(`${name} is ${JSON.stringify(process.env[name])}, expected ${value}`);
}
if (process.env.PGDATABASE !== undefined) throw new Error('PGDATABASE must be unset');
const baseUrl = ownedUrl(identity.database);
for (const name of ['TEST_DATABASE_URL', 'DATABASE_URL']) {
  if (process.env[name] !== baseUrl) throw new Error(`${name} must be exactly ${baseUrl}`);
}
const pid = verifyOwnedCluster(identity, await systemProbe());

// The named base, then the maintenance database @oxy.so/db/testing rewrites it
// to for CREATE/DROP DATABASE. Both must resolve to the same owned socket.
const targets = [
  [identity.database, baseUrl],
  [MAINTENANCE_DATABASE, maintenanceUrlOf(baseUrl)],
];
for (const [database, url] of targets) {
  const client = await createVerifiedClient(postgres, identity, url);
  try {
    const [data] = await client`show data_directory`;
    const [tcp] = await client`show listen_addresses`;
    assertServerIdentity(identity, data.data_directory, tcp.listen_addresses);
    const [row] = await client`select current_database() as database, current_user as role`;
    if (row.database !== database || row.role !== identity.user) {
      throw new Error(
        `Connected as ${row.role} to ${row.database}, expected ${identity.user} to ${database}`,
      );
    }
  } finally {
    await client.end({ timeout: 1 });
  }
  console.log(
    `Owned PostgreSQL verified for ${database}: postmaster ${pid}, ${identity.data}, socket ${identity.socket}, TCP disabled`,
  );
}
