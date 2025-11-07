import { useState, useCallback, useRef } from "react";
import { TextInput } from "react-native";

export const usePollManager = () => {
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [pollTitle, setPollTitle] = useState("");
  const [pollOptions, setPollOptions] = useState<string[]>([]);
  const pollTitleInputRef = useRef<TextInput | null>(null);

  const focusPollCreator = useCallback(() => {
    setShowPollCreator(true);
    setPollOptions((prev) => (prev.length >= 2 ? prev : ["", ""]));
    setTimeout(() => {
      pollTitleInputRef.current?.focus();
    }, 50);
  }, []);

  const addPollOption = useCallback(() => {
    setPollOptions((prev) => [...prev, ""]);
  }, []);

  const updatePollOption = useCallback((index: number, value: string) => {
    setPollOptions((prev) => prev.map((option, i) => (i === index ? value : option)));
  }, []);

  const removePollOption = useCallback((index: number) => {
    setPollOptions((prev) => {
      if (prev.length > 2) {
        return prev.filter((_, i) => i !== index);
      }
      return prev;
    });
  }, []);

  const removePoll = useCallback(() => {
    setShowPollCreator(false);
    setPollOptions([]);
    setPollTitle("");
    pollTitleInputRef.current?.blur();
  }, []);

  const clearPoll = useCallback(() => {
    setShowPollCreator(false);
    setPollOptions([]);
    setPollTitle("");
  }, []);

  return {
    showPollCreator,
    setShowPollCreator,
    pollTitle,
    setPollTitle,
    pollOptions,
    setPollOptions,
    pollTitleInputRef,
    focusPollCreator,
    addPollOption,
    updatePollOption,
    removePollOption,
    removePoll,
    clearPoll,
  };
};
