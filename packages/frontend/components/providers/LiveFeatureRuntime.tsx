import { useEffect } from 'react';
import {
  CreateRoomSheet,
  LiveConfigProvider,
  LiveRoomProvider,
  useLiveRoom as useSyraLiveRoom,
} from '@syra.fm/sdk';
import type { CreateRoomSheetProps } from '@/components/rooms/createRoomTypes';
import { liveConfig } from '@/lib/liveConfig';
import { initLiveKit } from '@/lib/livekit';
import { liveRoomRuntimeController } from '@/context/LiveRoomContext';

// Native WebRTC globals are registered only when this async feature chunk loads.
initLiveKit();

function LiveRoomControllerBridge() {
  const syraController = useSyraLiveRoom();

  useEffect(
    () => liveRoomRuntimeController.bindRuntime(syraController),
    [syraController]
  );

  return null;
}

/**
 * The one persistent owner of Syra's room/audio state. It is mounted by
 * `LiveFeatureHost` after the first request and never follows route lifecycles.
 */
export default function LiveFeatureRuntime() {
  return (
    <LiveConfigProvider config={liveConfig}>
      <LiveRoomProvider>
        <LiveRoomControllerBridge />
      </LiveRoomProvider>
    </LiveConfigProvider>
  );
}

/**
 * The create form shares this same async module so Metro keeps the complete
 * Syra dependency graph in one feature chunk instead of promoting shared audio
 * dependencies into the initial common bundle.
 */
export function LiveCreateRoomRuntime(props: CreateRoomSheetProps) {
  return (
    <LiveConfigProvider config={liveConfig}>
      <CreateRoomSheet {...props} />
    </LiveConfigProvider>
  );
}
