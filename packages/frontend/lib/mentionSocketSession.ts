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
