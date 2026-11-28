// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { Server } from 'node:http';
import type { Express } from 'express';
import { afterEach } from 'vitest';

/** Keep each app listening across a request batch, then close it after the test. */
export function useHttpTestServers(): (app: Express) => Promise<Server> {
  const servers = new Set<Server>();

  afterEach(async () => {
    await Promise.all(
      [...servers].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            // Also release an in-flight request if its test failed or timed out.
            server.closeAllConnections();
          }),
      ),
    );
    servers.clear();
  });

  return (app) =>
    new Promise<Server>((resolve, reject) => {
      // Passing an Express app directly to supertest opens and closes a listener
      // for EVERY request. Rate-limit tests issue hundreds of sequential requests;
      // their budget should cover the route, not repeated listener teardown.
      // The per-request `listen(0)` is also a SYNCHRONOUS bind on the dual-stack
      // address — ~20 ms each on a WSL2 host, against ~0 ms for 127.0.0.1 — so
      // a burst of concurrent `request(app)` calls blocks the event loop for
      // the whole burst before the first request is even sent.
      const server = app.listen(0, '127.0.0.1', () => {
        servers.add(server);
        resolve(server);
      });
      server.once('error', reject);
    });
}
