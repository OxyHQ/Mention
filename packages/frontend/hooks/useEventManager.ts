import { useState, useCallback } from "react";

export interface EventData {
  name: string;
  date: string; // ISO date string
  location?: string;
  description?: string;
}

export const useEventManager = () => {
  const [event, setEvent] = useState<EventData | null>(null);
  const [isEventEditorVisible, setIsEventEditorVisible] = useState(false);
  const [eventDraftName, setEventDraftName] = useState("");
  const [eventDraftDate, setEventDraftDate] = useState("");
  const [eventDraftLocation, setEventDraftLocation] = useState("");
  const [eventDraftDescription, setEventDraftDescription] = useState("");

  const openEventEditor = useCallback(() => {
    setEventDraftName(event?.name || "");
    setEventDraftDate(event?.date || "");
    setEventDraftLocation(event?.location || "");
    setEventDraftDescription(event?.description || "");
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
        name, 
        date,
        location: eventDraftLocation.trim() || undefined,
        description: eventDraftDescription.trim() || undefined,
      });
    }
    setIsEventEditorVisible(false);
  }, [eventDraftName, eventDraftDate, eventDraftLocation, eventDraftDescription]);

  const removeEvent = useCallback(() => {
    setEvent(null);
    setEventDraftName("");
    setEventDraftDate("");
    setEventDraftLocation("");
    setEventDraftDescription("");
  }, []);

  const hasContent = useCallback(() => {
    if (!event) return false;
    return Boolean(event.name?.trim() && event.date?.trim());
  }, [event]);

  const loadEventFromDraft = useCallback((draftEvent: EventData | null) => {
    setEvent(draftEvent);
  }, []);

  const clearEvent = useCallback(() => {
    setEvent(null);
    setEventDraftName("");
    setEventDraftDate("");
    setEventDraftLocation("");
    setEventDraftDescription("");
    setIsEventEditorVisible(false);
  }, []);

  return {
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
    hasContent,
    loadEventFromDraft,
    clearEvent,
  };
};

