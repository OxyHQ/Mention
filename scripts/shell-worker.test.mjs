// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import worker from '../packages/frontend/worker/index.js';

test('shell access gate denies without the key and streams assets with it', async () => {
  let assets = 0;
  const response = new Response('private shell');
  const env = {
    ASSETS: {
      fetch: async () => {
        assets++;
        return response;
      },
    },
  };
  const missing = await worker.fetch(new Request('https://shell.mention.earth/'), env);
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  env.SHELL_ACCESS_KEY = 'test-shell-key';
  const denied = await worker.fetch(new Request('https://shell.mention.earth/'), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(assets, 0);
  const previous = crypto.subtle.timingSafeEqual;
  crypto.subtle.timingSafeEqual = timingSafeEqual;
  try {
    const wrong = new Request('https://shell.mention.earth/', {
      headers: { 'x-mention-shell-key': 'wrong-shell-key' },
    });
    assert.equal((await worker.fetch(wrong, env)).status, 403);
    assert.equal(assets, 0);
    const request = new Request('https://shell.mention.earth/', {
      headers: { 'x-mention-shell-key': env.SHELL_ACCESS_KEY },
    });
    assert.equal(await worker.fetch(request, env), response);
    assert.equal(assets, 1);
  } finally {
    if (previous === undefined) delete crypto.subtle.timingSafeEqual;
    else crypto.subtle.timingSafeEqual = previous;
  }
});
