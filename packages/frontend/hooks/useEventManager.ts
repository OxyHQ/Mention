import { useState, useCallback } from 'react';

export interface EventData {
  capacity?: number | null;
  name: string;
  date: string; // ISO date string
  location?: string;
  description?: string;
}

export const useEventManager = () => {
  const [event, setEvent] = useState<EventData | null>(null);
  const [isEventEditorVisible, setIsEventEditorVisible] = useState(false);
  const [eventDraftCapacity, setEventDraftCapacity] = useState('');
  const [eventDraftName, setEventDraftName] = useState('');
  const [eventDraftDate, setEventDraftDate] = useState('');
  const [eventDraftLocation, setEventDraftLocation] = useState('');
  const [eventDraftDescription, setEventDraftDescription] = useState('');

  const openEventEditor = useCallback(() => {
    setEventDraftCapacity(event?.capacity ? String(event.capacity) : '');
    setEventDraftName(event?.name || '');
    setEventDraftDate(event?.date || new Date().toISOString());
    setEventDraftLocation(event?.location || '');
    setEventDraftDescription(event?.description || '');
    setIsEventEditorVisible(true);
  }, [event]);

  const closeEventEditor = useCallback(() => {
    setIsEventEditorVisible(false);
  }, []);

  const saveEvent = useCallback(() => {
    const name = eventDraftName.trim();
    const date = eventDraftDate.trim();
    if (!name || !date) {
      setEvent(null);
    } else {
      setEvent({
        capacity: eventDraftCapacity.trim() ? Number(eventDraftCapacity) : null,
        name,
        date,
        location: eventDraftLocation.trim() || undefined,
        description: eventDraftDescription.trim() || undefined,
      });
    }
    setIsEventEditorVisible(false);
  }, [
    eventDraftName,
    eventDraftDate,
    eventDraftLocation,
    eventDraftDescription,
    eventDraftCapacity,
  ]);

  const removeEvent = useCallback(() => {
    setEvent(null);
    setEventDraftName('');
    setEventDraftDate('');
    setEventDraftLocation('');
    setEventDraftDescription('');
  }, []);

  const loadEventFromDraft = useCallback((draftEvent: EventData | null) => {
    setEvent(draftEvent);
  }, []);

  const clearEvent = useCallback(() => {
    setEvent(null);
    setEventDraftName('');
    setEventDraftDate('');
    setEventDraftLocation('');
    setEventDraftDescription('');
    setIsEventEditorVisible(false);
  }, []);

  return {
    eventDraftCapacity,
    setEventDraftCapacity,
    event,
    setEvent,
    isEventEditorVisible,
    eventDraftName,
    setEventDraftName,
    eventDraftDate,
    setEventDraftDate,
    eventDraftLocation,
    setEventDraftLocation,
    eventDraftDescription,
    setEventDraftDescription,
    openEventEditor,
    closeEventEditor,
    saveEvent,
    removeEvent,
    loadEventFromDraft,
    clearEvent,
  };
};
