// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { OxyServices } from '@oxy.so/core';

/** The shared Oxy session owns Mention's Socket.IO handshake and account lifetime. */
export function createMentionSocketSession(
  oxy: OxyServices,
  apiURL: string,
  target: string,
  onContextEnd: () => void,
) {
  const linked = oxy.createLinkedClient({ baseURL: apiURL });
  const epoch = oxy.http.getSessionEpoch();
  const controller = new AbortController();
  let disconnect: (() => void) | undefined;
  let disposed = false;
  const unsubscribe = oxy.http.addTokenChangeListener(() => {
    if (oxy.http.getSessionEpoch() === epoch) return;
    dispose();
    disconnect?.();
    onContextEnd();
  });
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unsubscribe();
    linked.dispose();
  }
  return {
    auth(callback: (value: { token?: string }) => void) {
      void linked.getAccessToken(target, { signal: controller.signal }).then(
        (token) => {
          if (!controller.signal.aborted) callback({ token });
        },
        () => {
          if (!controller.signal.aborted) callback({});
        },
      );
    },
    bind(close: () => void) {
      disconnect = close;
      if (controller.signal.aborted) close();
    },
    dispose,
  };
}
