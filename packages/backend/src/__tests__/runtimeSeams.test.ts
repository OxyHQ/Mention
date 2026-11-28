// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { afterEach, describe, expect, it } from 'bun:test';
import {
  clearRuntimeOxyClient,
  getRuntimeOxyClient,
  setRuntimeOxyClient,
} from '../runtime/oxyClient';
import {
  clearRuntimeSocketServer,
  getRuntimeSocketServer,
  setRuntimeSocketServer,
} from '../runtime/socketServer';

afterEach(() => {
  clearRuntimeOxyClient();
  clearRuntimeSocketServer();
});

describe('runtime service seams', () => {
  it('returns the explicitly registered Oxy client without booting the server', () => {
    const client = { getUserById: async () => ({ id: 'u1' }) };
    setRuntimeOxyClient(client as never);

    expect(getRuntimeOxyClient()).toBe(client);
  });

  it('only clears the Socket.IO server owned by the caller', () => {
    const first = { emit: () => undefined };
    const second = { emit: () => undefined };

    setRuntimeSocketServer(first as never);
    clearRuntimeSocketServer(second as never);
    expect(getRuntimeSocketServer()).toBe(first);

    clearRuntimeSocketServer(first as never);
    expect(getRuntimeSocketServer()).toBeUndefined();
  });
});
