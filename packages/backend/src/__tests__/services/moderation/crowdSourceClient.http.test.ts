import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetCrowdSourceForOxyService } from '@crowdsource.you/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The CrowdSource client must authenticate through the `@oxy.so/core` this
 * backend actually installs.
 *
 * `@crowdsource.you/core` mints its Oxy service token by loading `@oxy.so/core`
 * at runtime, so nothing at compile time notices when the two drift apart:
 * 1.4.0 looked for the `oxyClient` singleton core 4 no longer exports, and every
 * community-notes lookup on every feed page failed before leaving the process.
 * Real loopback HTTP for both Oxy and CrowdSource; only the responses are fixtures.
 */

const settings = vi.hoisted(() => ({ crowdSource: { baseUrl: undefined as string | undefined } }));
vi.mock('../../../config', () => ({ config: settings }));

import { getCrowdSourceClient } from '../../../services/moderation/crowdSourceClient';

const SERVICE_TOKEN = 'fixture_oxy_service_token';
const requests: Array<{ path: string; authorization?: string }> = [];
let server: http.Server;
const savedEnv: Record<string, string | undefined> = {};
const ENV = ['OXY_API_URL', 'OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET'] as const;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/service-token') {
      res.end(JSON.stringify({ token: SERVICE_TOKEN, expiresIn: 3600 }));
    } else if (req.url?.startsWith('/v1/community-notes/shown')) {
      res.end(JSON.stringify({ notes: [] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // `localhost`, not 127.0.0.1: the SDK refuses a plain-http base URL anywhere else.
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

  for (const name of ENV) savedEnv[name] = process.env[name];
  process.env.OXY_API_URL = origin;
  process.env.OXY_SERVICE_API_KEY = 'fixture_key';
  process.env.OXY_SERVICE_API_SECRET = 'fixture_secret';
  settings.crowdSource.baseUrl = origin;
  resetCrowdSourceForOxyService();
});

afterAll(async () => {
  resetCrowdSourceForOxyService();
  for (const name of ENV) {
    if (savedEnv[name] === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = savedEnv[name];
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('CrowdSource client on the installed Oxy SDK', () => {
  it('mints an Oxy service token and presents it to CrowdSource', async () => {
    const client = getCrowdSourceClient();
    expect(client).toBeDefined();

    await expect(client?.communityNotes.shown(['post_1', 'post_2'])).resolves.toEqual([]);

    expect(requests.some((request) => request.path === '/auth/service-token')).toBe(true);
    const lookup = requests.find((request) => request.path.startsWith('/v1/community-notes/shown'));
    expect(lookup?.path).toBe('/v1/community-notes/shown?subjects=post_1,post_2');
    expect(lookup?.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });
});
