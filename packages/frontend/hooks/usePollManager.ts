import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from 'react';
import type { TextInputInstance } from 'react-native';
import { DEFAULT_POLL_DURATION_DAYS } from '@/utils/composeContent';

/**
 * Spelled out rather than inferred: the inferred ref type names React Native
 * 0.88's internal `_TextInputInstance`, which a composite project cannot emit (TS2883).
 */
export interface PollManager {
  showPollCreator: boolean;
  setShowPollCreator: Dispatch<SetStateAction<boolean>>;
  pollTitle: string;
  setPollTitle: Dispatch<SetStateAction<string>>;
  pollOptions: string[];
  setPollOptions: Dispatch<SetStateAction<string[]>>;
  pollDurationDays: number;
  setPollDurationDays: Dispatch<SetStateAction<number>>;
  pollTitleInputRef: RefObject<TextInputInstance | null>;
  focusPollCreator: () => void;
  addPollOption: () => void;
  updatePollOption: (index: number, value: string) => void;
  removePollOption: (index: number) => void;
  removePoll: () => void;
  clearPoll: () => void;
}

export const usePollManager = (): PollManager => {
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [pollTitle, setPollTitle] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>([]);
  const [pollDurationDays, setPollDurationDays] = useState(DEFAULT_POLL_DURATION_DAYS);
  const pollTitleInputRef = useRef<TextInputInstance | null>(null);

  const focusPollCreator = useCallback(() => {
    setShowPollCreator(true);
    setPollOptions((prev) => (prev.length >= 2 ? prev : ['', '']));
    setTimeout(() => {
      pollTitleInputRef.current?.focus();
    }, 50);
  }, []);

  const addPollOption = useCallback(() => {
    setPollOptions((prev) => [...prev, '']);
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
    setPollTitle('');
    setPollDurationDays(DEFAULT_POLL_DURATION_DAYS);
    pollTitleInputRef.current?.blur();
  }, []);

  const clearPoll = useCallback(() => {
    setShowPollCreator(false);
    setPollOptions([]);
    setPollTitle('');
    setPollDurationDays(DEFAULT_POLL_DURATION_DAYS);
  }, []);

  return {
    showPollCreator,
    setShowPollCreator,
    pollTitle,
    setPollTitle,
    pollOptions,
    setPollOptions,
    pollDurationDays,
    setPollDurationDays,
    pollTitleInputRef,
    focusPollCreator,
    addPollOption,
    updatePollOption,
    removePollOption,
    removePoll,
    clearPoll,
  };
};
