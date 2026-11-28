// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import http from 'node:http';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const clients = vi.hoisted(() => ({
  publisher: { connect: vi.fn(), quit: vi.fn(), isOpen: false, isReady: false },
  subscriber: { connect: vi.fn(), quit: vi.fn(), isOpen: false, isReady: false },
}));
vi.mock('../../utils/redis', () => ({ createRedisPubSub: () => clients }));
import {
  attachSocketRedisAdapter,
  closeSocketRedisAdapter,
  isSocketRedisAdapterReady,
} from '../../runtime/socketRedisAdapter';

describe('split realtime transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clients.publisher.connect.mockRejectedValue(new Error('Redis unavailable'));
    clients.subscriber.connect.mockResolvedValue(undefined);
    clients.publisher.isOpen = true;
    clients.subscriber.isOpen = true;
  });
  afterEach(() => closeSocketRedisAdapter());
  it('fails split startup and cleans both connections instead of accepting a local-only emitter', async () => {
    const emitter = new Server(http.createServer());
    await expect(attachSocketRedisAdapter(emitter, true)).rejects.toThrow('Redis unavailable');
    expect(isSocketRedisAdapterReady()).toBe(false);
    expect(clients.publisher.quit).toHaveBeenCalledOnce();
    expect(clients.subscriber.quit).toHaveBeenCalledOnce();
    await closeSocketRedisAdapter();
    expect(clients.publisher.quit).toHaveBeenCalledOnce();
    await emitter.close();
  });
  it('retains the existing combined-mode fallback', async () => {
    const emitter = new Server(http.createServer());
    await expect(attachSocketRedisAdapter(emitter)).resolves.toBeUndefined();
    expect(isSocketRedisAdapterReady()).toBe(false);
    await emitter.close();
  });
});
