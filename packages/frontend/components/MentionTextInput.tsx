import React, { useState, useRef, useCallback, useImperativeHandle, forwardRef, useEffect, useMemo, memo } from "react";
import {
    View,
    TextInput,
    StyleSheet,
    TextInputProps,
    Platform,
    NativeSyntheticEvent,
    TextInputContentSizeChangeEventData,
    TextInputSelectionChangeEventData,
    type StyleProp,
    type TextStyle,
} from "react-native";
import { useTheme } from '@oxyhq/bloom/theme';
import MentionPicker, { MentionUser } from "./MentionPicker";
import { asTextStyle } from "@/types/webStyles";
import {
    displayTextToStorageText,
    mergeMentionData,
    storageTextToDisplayText,
    type MentionData,
    type MentionTextValue,
} from "@/utils/mentions";

export interface MentionTextInputHandle {
    /** Insert text at the current cursor position */
    insertTextAtCursor: (text: string) => void;
    /** Focus the underlying TextInput */
    focus: () => void;
}

interface MentionTextInputProps extends Omit<TextInputProps, "onChange" | "onChangeText" | "value"> {
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

const MentionTextInput = memo(forwardRef<MentionTextInputHandle, MentionTextInputProps>(({
    value,
    mentions,
    onValueChange,
    placeholder,
    maxLength,
    multiline = true,
    style,
    ...textInputProps
}, ref) => {
    const theme = useTheme();
    const [showMentionPicker, setShowMentionPicker] = useState(false);
    const [mentionQuery, setMentionQuery] = useState("");
    const [cursorPosition, setCursorPosition] = useState(0);
    const textInputRef = useRef<TextInput>(null);
    const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);

    // Native: use onContentSizeChange to track height
    const handleContentSizeChange = useCallback(
        (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
            if (Platform.OS !== 'web' && multiline) {
                setContentHeight(event.nativeEvent.contentSize.height);
            }
        },
        [multiline]
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
    const handleTextChange = useCallback((text: string) => {
        // Text from input is in display format (@name)
        // We need to convert to storage format for the parent component
        const storageText = displayTextToStorageText(text, mentions);
        onValueChange({ text: storageText, mentions: [...mentions] });

        // Check if user is typing a mention
        const cursorPos = cursorPosition;
        const textBeforeCursor = text.substring(0, cursorPos);
        const lastAtSymbol = textBeforeCursor.lastIndexOf("@");

        if (lastAtSymbol !== -1) {
            const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);

            // Check if it's a valid mention query (no spaces)
            const hasSpace = textAfterAt.includes(" ");
            const hasNewline = textAfterAt.includes("\n");

            if (!hasSpace && !hasNewline && textAfterAt.length >= 0) {
                setMentionQuery(textAfterAt);
                setShowMentionPicker(true);
            } else {
                setShowMentionPicker(false);
                setMentionQuery("");
            }
        } else {
            setShowMentionPicker(false);
            setMentionQuery("");
        }
    }, [cursorPosition, mentions, onValueChange]);

    // Handle selection change to track cursor position
    const handleSelectionChange = useCallback((event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        setCursorPosition(event.nativeEvent.selection.start);
    }, []);

    // Handle user selection from mention picker
    const handleMentionSelect = useCallback((user: MentionUser) => {
        // Convert current storage value to display to find @ position
        const currentDisplayValue = storageTextToDisplayText(value, mentions);
        const textBeforeCursor = currentDisplayValue.substring(0, cursorPosition);
        const textAfterCursor = currentDisplayValue.substring(cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf("@");

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
                " " +
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
        setMentionQuery("");
    }, [value, cursorPosition, mentions, onValueChange]);

    const handleClosePicker = useCallback(() => {
        setShowMentionPicker(false);
        setMentionQuery("");
    }, []);

    // Expose imperative methods via ref
    useImperativeHandle(ref, () => ({
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
    }), [value, cursorPosition, mentions, onValueChange]);

    // Convert storage format to display format for rendering
    const displayValue = useMemo(
        () => storageTextToDisplayText(value, mentions),
        [value, mentions],
    );

    const inputStyle = useMemo(() => [
        styles.textInput,
        Platform.OS !== 'web' && multiline && contentHeight !== undefined && { height: contentHeight },
        style,
    ], [multiline, contentHeight, style]);

    return (
        <View style={styles.container}>
            <TextInput
                ref={textInputRef}
                value={displayValue}
                onChangeText={handleTextChange}
                onSelectionChange={handleSelectionChange}
                onContentSizeChange={handleContentSizeChange}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.textTertiary}
                maxLength={maxLength}
                multiline={multiline}
                className="text-foreground"
                style={inputStyle}
                {...textInputProps}
            />

            {showMentionPicker && (
                <View style={styles.pickerContainer}>
                    <MentionPicker
                        query={mentionQuery}
                        onSelect={handleMentionSelect}
                        onClose={handleClosePicker}
                    />
                </View>
            )}
        </View>
    );
}));

MentionTextInput.displayName = 'MentionTextInput';

const styles = StyleSheet.create({
    container: {
        position: "relative",
    },
    textInput: {
        fontSize: 16,
        textAlignVertical: "top",
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
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
});

export default MentionTextInput;
export type { MentionTextInputProps };
export type { MentionData, MentionTextValue } from "@/utils/mentions";
