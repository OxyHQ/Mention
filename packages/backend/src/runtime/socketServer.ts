// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { Server as SocketIOServer } from 'socket.io';

/**
 * Late-bound Socket.IO seam for domain code that emits outside an HTTP handler.
 * Importing this module never creates a server or opens a socket.
 */
let runtimeSocketServer: SocketIOServer | undefined;

export function setRuntimeSocketServer(server: SocketIOServer): void {
  runtimeSocketServer = server;
}

export function getRuntimeSocketServer(): SocketIOServer | undefined {
  return runtimeSocketServer;
}

export function clearRuntimeSocketServer(server?: SocketIOServer): void {
  if (!server || runtimeSocketServer === server) {
    runtimeSocketServer = undefined;
  }
}
