// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

/**
 * THE PROFILE-LINK RESOLVER IS BEHIND AUTHENTICATION, AND THE MOUNT IS THE ONLY
 * THING THAT PUTS IT THERE.
 *
 * The handler deliberately runs no auth check of its own — `authenticatedApi` is
 * mounted behind `requireAuth` in `app.ts`, so a check inside would be a second
 * gate free to disagree with the real one. That makes WHICH router it is mounted
 * on the whole of its access control: moved to `publicApi` (a one-line edit,
 * next to routers that legitimately live there) it becomes an unauthenticated
 * oracle that turns any profile URL into an Oxy user id.
 *
 * So this asserts the composition itself rather than the file's text: the route
 * answers on the authenticated router and is absent from the public one.
 */

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(() => ({})),
  createScopedOxyClient: vi.fn(() => ({})),
}));

import { createAppRoutes } from '../../appRoutes';

const noop: RequestHandler = (_req, _res, next) => next();

function appFor(router: 'publicApi' | 'authenticatedApi') {
  const routes = createAppRoutes({
    // Only the shapes `createAppRoutes` itself reads; the routers it composes
    // are the real ones.
    oxy: { middleware: { auth: () => noop } } as unknown as Parameters<
      typeof createAppRoutes
    >[0]['oxy'],
    optionalAuth: noop,
  });
  const app = express();
  app.use(express.json());
  app.use('/', routes[router]);
  return app;
}

describe('POST /mentions/profile-links is mounted behind authentication', () => {
  it('is absent from the PUBLIC router', async () => {
    const response = await request(appFor('publicApi'))
      .post('/mentions/profile-links')
      .send({ urls: [] });

    expect(response.status).toBe(404);
  });

  it('is served by the AUTHENTICATED router', async () => {
    const response = await request(appFor('authenticatedApi'))
      .post('/mentions/profile-links')
      .send({ urls: [] });

    // Reached the handler — the empty batch is a valid request with no answers.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ links: [] });
  });
});
