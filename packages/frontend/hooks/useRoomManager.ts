import { useCallback, useState } from 'react';

/**
 * Lightweight composer-only representation of a Syra room attachment.
 *
 * Keeping this state hook local prevents the LiveKit-backed Syra runtime from
 * entering the initial app bundle merely because the composer can attach a
 * room. The full engine is still loaded at the live-room route boundary.
 */
export interface RoomAttachmentData {
  roomId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  type?: 'talk' | 'stage' | 'broadcast';
  topic?: string;
  host?: string;
}

export function useRoomManager() {
  const [room, setRoom] = useState<RoomAttachmentData | null>(null);

  const attachRoom = useCallback((data: RoomAttachmentData) => {
    setRoom(data);
  }, []);
  const removeRoom = useCallback(() => {
    setRoom(null);
  }, []);
  const hasContent = useCallback(
    () => Boolean(room?.roomId && room.title.trim()),
    [room],
  );
  const loadRoomFromDraft = useCallback((draftRoom: RoomAttachmentData | null) => {
    setRoom(draftRoom);
  }, []);
  const clearRoom = useCallback(() => {
    setRoom(null);
  }, []);

  return {
    room,
    setRoom,
    attachRoom,
    removeRoom,
    hasContent,
    loadRoomFromDraft,
    clearRoom,
  };
}
