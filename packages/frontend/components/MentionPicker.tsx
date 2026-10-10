import type React from 'react';
import { useMemo } from 'react';
import { SuggestionList, type ChatComposerSuggestion } from '@oxy.so/bloom/chat-composer';
import type { MentionUser } from '@/utils/mentionSearch';

export type { MentionUser };

interface MentionPickerProps {
  /** The accounts to offer, from `useMentionSearchResults`. */
  users: readonly MentionUser[];
  /** The search for the current query has not answered yet. */
  loading: boolean;
  /** The highlighted row. The input owns it: its arrow keys move it. */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (user: MentionUser) => void;
  maxHeight?: number;
}

/**
 * The `@` picker: Bloom's `SuggestionList` for people, fed by the composer's
 * mention search. Bloom owns the rows, the verified marker, the searching and
 * nothing-found lines, and the listbox semantics; this only maps accounts to
 * suggestions.
 */
const MentionPicker: React.FC<MentionPickerProps> = ({
  users,
  loading,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  maxHeight,
}) => {
  const suggestions = useMemo<ChatComposerSuggestion[]>(
    () =>
      users.map((user) => ({
        id: user.id,
        // The shared identity rule: the display name, else the handle — once.
        label: user.displayName || `@${user.username}`,
        handle: user.displayName ? `@${user.username}` : undefined,
        avatar: user.avatar,
        verified: user.verified,
      })),
    [users],
  );

  return (
    <SuggestionList
      kind="mention"
      suggestions={suggestions}
      activeIndex={activeIndex}
      onActiveIndexChange={onActiveIndexChange}
      onSelectSuggestion={(_suggestion, index) => {
        const user = users[index];
        if (user) onSelect(user);
      }}
      loading={loading}
      showEmpty
      maxHeight={maxHeight}
    />
  );
};

export default MentionPicker;
