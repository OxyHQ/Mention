import {
  createContext,
  use,
  useMemo,
  useSyncExternalStore,
  type PropsWithChildren,
} from 'react';

export interface LiveRoomRuntimeBridge {
  activeRoomId: string | null;
  joinLiveRoom: (roomId: string) => void;
  leaveLiveRoom: () => void;
}

export interface LiveRoomSnapshot {
  activeRoomId: string | null;
  runtimeRequested: boolean;
}

export interface LiveRoomController extends LiveRoomSnapshot {
  requestRuntime: () => void;
  joinLiveRoom: (roomId: string) => void;
  leaveLiveRoom: () => void;
}

export interface LiveRoomRuntimeController {
  getSnapshot: () => LiveRoomSnapshot;
  subscribe: (listener: () => void) => () => void;
  requestRuntime: () => void;
  joinLiveRoom: (roomId: string) => void;
  leaveLiveRoom: () => void;
  bindRuntime: (bridge: LiveRoomRuntimeBridge) => () => void;
  resetViewerState: () => void;
}

const INITIAL_SNAPSHOT: LiveRoomSnapshot = {
  activeRoomId: null,
  runtimeRequested: false,
};

/**
 * Small process-local command bus between lightweight app surfaces and the
 * lazily loaded Syra provider. It contains no SDK or LiveKit imports.
 */
export function createLiveRoomRuntimeController(): LiveRoomRuntimeController {
  let snapshot = INITIAL_SNAPSHOT;
  let bridge: LiveRoomRuntimeBridge | null = null;
  let pendingJoinRoomId: string | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: LiveRoomSnapshot) => {
    if (
      next.activeRoomId === snapshot.activeRoomId
      && next.runtimeRequested === snapshot.runtimeRequested
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const requestRuntime = () => {
    if (snapshot.runtimeRequested) return;
    publish({ ...snapshot, runtimeRequested: true });
  };

  const joinLiveRoom = (roomId: string) => {
    if (!roomId) return;
    requestRuntime();
    publish({ ...snapshot, activeRoomId: roomId });
    if (bridge) {
      pendingJoinRoomId = null;
      bridge.joinLiveRoom(roomId);
    } else {
      // Latest command wins while the dynamic runtime chunk is loading.
      pendingJoinRoomId = roomId;
    }
  };

  const leaveLiveRoom = () => {
    pendingJoinRoomId = null;
    bridge?.leaveLiveRoom();
    publish({ ...snapshot, activeRoomId: null });
  };

  const resetViewerState = () => {
    pendingJoinRoomId = null;
    bridge?.leaveLiveRoom();
    publish(INITIAL_SNAPSHOT);
  };

  const bindRuntime = (nextBridge: LiveRoomRuntimeBridge) => {
    bridge = nextBridge;
    const queuedRoomId = pendingJoinRoomId;
    if (queuedRoomId) {
      pendingJoinRoomId = null;
      nextBridge.joinLiveRoom(queuedRoomId);
    } else {
      publish({ ...snapshot, activeRoomId: nextBridge.activeRoomId });
    }

    return () => {
      if (bridge === nextBridge) bridge = null;
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestRuntime,
    joinLiveRoom,
    leaveLiveRoom,
    bindRuntime,
    resetViewerState,
  };
}

export const liveRoomRuntimeController = createLiveRoomRuntimeController();

const LiveRoomContext = createContext<LiveRoomRuntimeController>(
  liveRoomRuntimeController
);

export function LiveRoomControllerProvider({
  children,
  controller = liveRoomRuntimeController,
}: PropsWithChildren<{ controller?: LiveRoomRuntimeController }>) {
  return (
    <LiveRoomContext.Provider value={controller}>
      {children}
    </LiveRoomContext.Provider>
  );
}

/**
 * Lightweight, reactive command surface. Requesting or joining a room loads the
 * persistent runtime host without remounting this provider or its children.
 */
export function useLiveRoom(): LiveRoomController {
  const controller = use(LiveRoomContext);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  return useMemo(
    () => ({
      ...snapshot,
      requestRuntime: controller.requestRuntime,
      joinLiveRoom: controller.joinLiveRoom,
      leaveLiveRoom: controller.leaveLiveRoom,
    }),
    [controller, snapshot]
  );
}
