import { useState, useCallback } from "react";
import type { RoomAttachmentData } from "../types";

export const useRoomManager = () => {
  const [room, setRoom] = useState<RoomAttachmentData | null>(null);

  const attachRoom = useCallback((data: RoomAttachmentData) => { setRoom(data); }, []);
  const removeRoom = useCallback(() => { setRoom(null); }, []);
  const hasContent = useCallback(() => {
    if (!room) return false;
    return Boolean(room.roomId && room.title?.trim());
  }, [room]);
  const loadRoomFromDraft = useCallback((draftRoom: RoomAttachmentData | null) => { setRoom(draftRoom); }, []);
  const clearRoom = useCallback(() => { setRoom(null); }, []);

  return { room, setRoom, attachRoom, removeRoom, hasContent, loadRoomFromDraft, clearRoom };
};
