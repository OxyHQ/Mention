import { useState, useEffect, useRef } from 'react';
import { Room, RoomEvent, Participant } from 'livekit-client';

export function useActiveSpeakers(room: Room | null): Set<string> {
  const [activeSpeakerIds, setActiveSpeakerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const prevSetRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!room) {
      if (prevSetRef.current.size > 0) {
        prevSetRef.current = new Set();
        setActiveSpeakerIds(new Set());
      }
      return;
    }

    const handleActiveSpeakersChanged = (speakers: Participant[]) => {
      const newIds = new Set(speakers.map((s) => s.identity));
      const prev = prevSetRef.current;
      if (
        newIds.size !== prev.size ||
        [...newIds].some((id) => !prev.has(id))
      ) {
        prevSetRef.current = newIds;
        setActiveSpeakerIds(newIds);
      }
    };

    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakersChanged);
    };
  }, [room]);

  return activeSpeakerIds;
}
