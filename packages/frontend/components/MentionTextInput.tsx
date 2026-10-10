import React, {
  useState,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useEffect,
  useMemo,
  memo,
} from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  type TextInputProps,
  Platform,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import MentionPicker, { type MentionUser } from './MentionPicker';
import { asTextStyle } from '@/types/webStyles';
import {
  displayTextToStorageText,
  mergeMentionData,
  storageTextToDisplayText,
  type MentionData,
  type MentionTextValue,
} from '@/utils/mentions';
import { resolveTypedMentions } from '@/utils/mentionSearch';
import { useMentionSearchCache } from '@/context/MentionSearchContext';
import { useMentionSearchResults } from '@/hooks/useMentionSearchResults';
import { logger } from '@oxy.so/core/logger';

export interface MentionTextInputHandle {
  /** Insert text at the current cursor position */
  insertTextAtCursor: (text: string) => void;
  /** Focus the underlying TextInput */
  focus: () => void;
}

interface MentionTextInputProps
  extends Omit<TextInputProps, 'onChange' | 'onChangeText' | 'value'> {
  value: string;
  /** Post-scoped metadata registry controlled by the composer parent. */
  mentions: readonly MentionData[];
  /** Atomic storage-text + metadata candidate update. */
  onValueChange: (value: MentionTextValue) => void;
  placeholder?: string;
  maxLength?: number;
  multiline?: boolean;
  style?: StyleProp<TextStyle>;
}

const MentionTextInput = memo(
  forwardRef<MentionTextInputHandle, MentionTextInputProps>(
    (
      {
        value,
        mentions,
        onValueChange,
        placeholder,
        maxLength,
        multiline = true,
        style,
        onKeyPress,
        ...textInputProps
      },
      ref,
    ) => {
      const theme = useTheme();
      const [showMentionPicker, setShowMentionPicker] = useState(false);
      const [mentionQuery, setMentionQuery] = useState('');
      const [cursorPosition, setCursorPosition] = useState(0);
      const textInputRef = useRef<TextInput>(null);
      const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
      const searchCache = useMentionSearchCache();
      const pickerQuery = showMentionPicker ? mentionQuery : '';
      const { users: pickerUsers, loading: pickerLoading } = useMentionSearchResults(
        pickerQuery,
        searchCache,
      );
      // The highlighted row. The field owns it, not the list: its arrow keys move
      // it, and a pointer over a row reports it back through the list.
      const [activeIndex, setActiveIndex] = useState(0);
      useEffect(() => {
        setActiveIndex(0);
      }, [pickerQuery, pickerUsers]);

      // A lookup for a completed handle resolves after the author has kept
      // typing, so it applies to the value as it is THEN, not as it was.
      const latestRef = useRef({ value, mentions, onValueChange });
      useEffect(() => {
        latestRef.current = { value, mentions, onValueChange };
      }, [value, mentions, onValueChange]);
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      // A typed `@handle` the author has finished (a space, newline or
      // punctuation follows it) becomes a mention exactly as if it had been
      // picked, when the picker's search names that account and no other. The
      // answer comes from the session's search cache; only a handle nothing has
      // searched for yet costs one request, shared by every input in the session.
      const resolveCompletedHandles = useCallback(
        (candidate: MentionTextValue): MentionTextValue => {
          const { value: resolved, pending } = resolveTypedMentions(
            candidate,
            searchCache.findUser,
            { completedOnly: true },
          );
          for (const handle of pending) {
            searchCache
              .search(handle)
              .then(() => {
                if (!mountedRef.current) return;
                const latest = latestRef.current;
                const current = { text: latest.value, mentions: [...latest.mentions] };
                const next = resolveTypedMentions(current, searchCache.findUser, {
                  completedOnly: true,
                }).value;
                if (next !== current) latest.onValueChange(next);
              })
              .catch((error) => {
                logger.warn('Typed mention lookup failed', { handle, error });
              });
          }
          return resolved;
        },
        [searchCache],
      );

      // Native: use onContentSizeChange to track height
      const handleContentSizeChange = useCallback(
        (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
          if (Platform.OS !== 'web' && multiline) {
            setContentHeight(event.nativeEvent.contentSize.height);
          }
        },
        [multiline],
      );

      // Web: auto-grow textarea using scrollHeight technique
      // (CSS Tricks: set height to auto, then to scrollHeight)
      const autoGrowWeb = useCallback(() => {
        if (Platform.OS !== 'web' || !multiline || !textInputRef.current) return;
        // RNW TextInput exposes the DOM node directly or via _node
        const rnwRef = textInputRef.current as unknown as Record<string, unknown>;
        let node: HTMLElement | null = null;
        if (rnwRef instanceof HTMLElement) {
          node = rnwRef;
        } else if (typeof rnwRef._node === 'object' && rnwRef._node instanceof HTMLElement) {
          node = rnwRef._node;
        }
        if (!node || !('style' in node)) return;
        const el = node as HTMLTextAreaElement;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      }, [multiline]);

      useEffect(() => {
        autoGrowWeb();
      }, [value, autoGrowWeb]);

      // Handle text change
      const handleTextChange = useCallback(
        (text: string) => {
          // Text from input is in display format (@name)
          // We need to convert to storage format for the parent component
          const storageText = displayTextToStorageText(text, mentions);
          onValueChange(resolveCompletedHandles({ text: storageText, mentions: [...mentions] }));

          // Check if user is typing a mention
          const cursorPos = cursorPosition;
          const textBeforeCursor = text.substring(0, cursorPos);
          const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

          if (lastAtSymbol !== -1) {
            const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);

            // Check if it's a valid mention query (no spaces)
            const hasSpace = textAfterAt.includes(' ');
            const hasNewline = textAfterAt.includes('\n');

            if (!hasSpace && !hasNewline && textAfterAt.length >= 0) {
              setMentionQuery(textAfterAt);
              setShowMentionPicker(true);
            } else {
              setShowMentionPicker(false);
              setMentionQuery('');
            }
          } else {
            setShowMentionPicker(false);
            setMentionQuery('');
          }
        },
        [cursorPosition, mentions, onValueChange, resolveCompletedHandles],
      );

      // Handle selection change to track cursor position
      const handleSelectionChange = useCallback(
        (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
          setCursorPosition(event.nativeEvent.selection.start);
        },
        [],
      );

      // Handle user selection from mention picker
      const handleMentionSelect = useCallback(
        (user: MentionUser) => {
          // Convert current storage value to display to find @ position
          const currentDisplayValue = storageTextToDisplayText(value, mentions);
          const textBeforeCursor = currentDisplayValue.substring(0, cursorPosition);
          const textAfterCursor = currentDisplayValue.substring(cursorPosition);
          const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

          if (lastAtSymbol !== -1) {
            // Store mention metadata first
            const newMention: MentionData = {
              userId: user.id,
              username: user.username,
              displayName: user.displayName?.trim() || user.username,
            };

            const updatedMentions = mergeMentionData(mentions, [newMention]);

            // Display format uses @username (handle)
            const displayMentionText = `@${user.username}`;

            // Build display text (for cursor positioning)
            const newDisplayText =
              currentDisplayValue.substring(0, lastAtSymbol) +
              displayMentionText +
              ' ' +
              textAfterCursor;

            // Build storage text (what we send to parent)
            // We need to convert the new display text with updated mentions
            const storageText = displayTextToStorageText(newDisplayText, updatedMentions);

            // The parent owns reconciliation across this post's primary body and
            // every language rendition.
            onValueChange({ text: storageText, mentions: updatedMentions });

            // Move cursor after mention in display text
            const newCursorPos = lastAtSymbol + displayMentionText.length + 1;
            setCursorPosition(newCursorPos);

            // Set selection after a short delay
            setTimeout(() => {
              textInputRef.current?.setNativeProps?.({
                selection: { start: newCursorPos, end: newCursorPos },
              });
            }, 10);
          }

          setShowMentionPicker(false);
          setMentionQuery('');
        },
        [value, cursorPosition, mentions, onValueChange],
      );

      const handleClosePicker = useCallback(() => {
        setShowMentionPicker(false);
        setMentionQuery('');
      }, []);

      // The picker's keyboard, on web: ↑/↓ move the highlight (wrapping), Enter or
      // Tab takes it instead of breaking a line, Escape dismisses the list. With no
      // list open every key is the field's own. Web only: a phone's return key also
      // arrives as "Enter" and cannot be prevented there, so it would both take a
      // row AND break the line — on native the rows are tapped.
      const handleKeyPress = useCallback(
        (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
          const pickerOpen = Platform.OS === 'web' && showMentionPicker && mentionQuery.length > 0;
          const count = pickerUsers.length;
          const key = event.nativeEvent.key;
          let handled = false;
          if (pickerOpen && key === 'Escape') {
            handleClosePicker();
            handled = true;
          } else if (pickerOpen && count > 0 && key === 'ArrowDown') {
            setActiveIndex((index) => (index + 1) % count);
            handled = true;
          } else if (pickerOpen && count > 0 && key === 'ArrowUp') {
            setActiveIndex((index) => (index - 1 + count) % count);
            handled = true;
          } else if (pickerOpen && count > 0 && (key === 'Enter' || key === 'Tab')) {
            const user = pickerUsers[Math.min(activeIndex, count - 1)];
            if (user) handleMentionSelect(user);
            handled = true;
          }
          if (handled) {
            event.preventDefault();
            return;
          }
          onKeyPress?.(event);
        },
        [
          showMentionPicker,
          mentionQuery,
          pickerUsers,
          activeIndex,
          handleClosePicker,
          handleMentionSelect,
          onKeyPress,
        ],
      );

      // Expose imperative methods via ref
      useImperativeHandle(
        ref,
        () => ({
          insertTextAtCursor: (text: string) => {
            const displayValue = storageTextToDisplayText(value, mentions);
            const pos = Math.min(cursorPosition, displayValue.length);
            const before = displayValue.substring(0, pos);
            const after = displayValue.substring(pos);
            const newDisplayText = before + text + after;

            // Convert back to storage format
            const storageText = displayTextToStorageText(newDisplayText, mentions);
            onValueChange({ text: storageText, mentions: [...mentions] });

            // Update cursor position to after inserted text
            const newCursorPos = pos + text.length;
            setCursorPosition(newCursorPos);

            // Set selection on the native input
            setTimeout(() => {
              textInputRef.current?.setNativeProps?.({
                selection: { start: newCursorPos, end: newCursorPos },
              });
            }, 10);
          },
          focus: () => {
            textInputRef.current?.focus();
          },
        }),
        [value, cursorPosition, mentions, onValueChange],
      );

      // Convert storage format to display format for rendering
      const displayValue = useMemo(
        () => storageTextToDisplayText(value, mentions),
        [value, mentions],
      );

      const inputStyle = useMemo(
        () => [
          styles.textInput,
          Platform.OS !== 'web' &&
            multiline &&
            contentHeight !== undefined && { height: contentHeight },
          style,
        ],
        [multiline, contentHeight, style],
      );

      return (
        <View style={styles.container}>
          <TextInput
            ref={textInputRef}
            value={displayValue}
            onChangeText={handleTextChange}
            onSelectionChange={handleSelectionChange}
            onContentSizeChange={handleContentSizeChange}
            onKeyPress={handleKeyPress}
            placeholder={placeholder}
            placeholderTextColor={theme.colors.textTertiary}
            maxLength={maxLength}
            multiline={multiline}
            className="text-foreground"
            style={inputStyle}
            {...textInputProps}
          />

          {showMentionPicker && mentionQuery.length > 0 && (
            <View style={styles.pickerContainer}>
              <MentionPicker
                users={pickerUsers}
                loading={pickerLoading}
                activeIndex={activeIndex}
                onActiveIndexChange={setActiveIndex}
                onSelect={handleMentionSelect}
              />
            </View>
          )}
        </View>
      );
    },
  ),
);

MentionTextInput.displayName = 'MentionTextInput';

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  textInput: {
    fontSize: 16,
    textAlignVertical: 'top',
    ...Platform.select({
      web: asTextStyle({
        outlineStyle: 'none',
        outlineWidth: 0,
        resize: 'none',
        overflow: 'hidden',
      }),
    }),
  },
  pickerContainer: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 8,
    zIndex: 1000,
  },
});

export default MentionTextInput;
export type { MentionTextInputProps };
export type { MentionData, MentionTextValue } from '@/utils/mentions';
