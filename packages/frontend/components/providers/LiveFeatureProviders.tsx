import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
} from 'react';
import { useLiveRoom } from '@/context/LiveRoomContext';
import type { CreateRoomSheetProps } from '@/components/rooms/createRoomTypes';
import type { Room } from '@/lib/syraApi';

const DeferredLiveFeatureHost = lazy(() => import('./LiveFeatureRuntime'));
const DeferredCreateRoomSheet = lazy(() =>
  import('./LiveFeatureRuntime').then((module) => ({
    default: module.LiveCreateRoomRuntime,
  }))
);

/**
 * Stable root-level host. It renders nothing until requested, then keeps the
 * single Syra/LiveKit provider mounted across every route transition.
 */
export function LiveFeatureHost() {
  const { runtimeRequested } = useLiveRoom();
  if (!runtimeRequested) return null;

  return (
    <Suspense fallback={null}>
      <DeferredLiveFeatureHost />
    </Suspense>
  );
}

/** Request the persistent runtime when entering a live feature route. */
export function useRequestLiveFeatureRuntime() {
  const { requestRuntime } = useLiveRoom();
  useEffect(() => {
    requestRuntime();
  }, [requestRuntime]);
}

/**
 * Lazy create form. Syra's internal standalone join is intentionally unowned
 * here; a successfully created immediate room is handed to the persistent
 * controller, while embed/scheduled rooms remain unattached.
 */
export function LiveCreateRoomSheet(props: CreateRoomSheetProps) {
  const { requestRuntime, joinLiveRoom } = useLiveRoom();
  const { mode = 'standalone', onRoomCreated } = props;

  useEffect(() => {
    requestRuntime();
  }, [requestRuntime]);

  const handleRoomCreated = useCallback(
    (room: Room) => {
      if (mode === 'standalone' && !room.scheduledStart) {
        joinLiveRoom(room._id);
      }
      onRoomCreated?.(room);
    },
    [joinLiveRoom, mode, onRoomCreated]
  );

  return (
    <Suspense fallback={null}>
      <DeferredCreateRoomSheet
        {...props}
        mode={mode}
        onRoomCreated={handleRoomCreated}
      />
    </Suspense>
  );
}
