import React, { useState, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import {
    View,
    TextInput,
    StyleSheet,
    TextInputProps,
} from "react-native";
import { useTheme } from "@/hooks/useTheme";
import MentionPicker, { MentionUser } from "./MentionPicker";

export interface MentionData {
    userId: string;
    username: string;
    displayName: string;
}

export interface MentionTextInputHandle {
    /** Insert text at the current cursor position */
    insertTextAtCursor: (text: string) => void;
    /** Focus the underlying TextInput */
    focus: () => void;
}

interface MentionTextInputProps extends Omit<TextInputProps, "onChangeText" | "value"> {
    value: string;
    onChangeText: (text: string) => void;
    onMentionsChange?: (mentions: MentionData[]) => void;
    placeholder?: string;
    maxLength?: number;
    multiline?: boolean;
    style?: any;
}

const MentionTextInput = forwardRef<MentionTextInputHandle, MentionTextInputProps>(({
    value,
    onChangeText,
    onMentionsChange,
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
    const [mentions, setMentions] = useState<MentionData[]>([]);
    const textInputRef = useRef<TextInput>(null);

    // Convert display text with @username to storage format with [mention:userId]
    const convertToStorageFormat = useCallback((displayText: string, currentMentions: MentionData[]): string => {
        let result = displayText;
        // Replace @username with [mention:userId]
        currentMentions.forEach(mention => {
            const displayMention = `@${mention.username}`;
            const storageMention = `[mention:${mention.userId}]`;
            result = result.replace(displayMention, storageMention);
        });
        return result;
    }, []);

    // Convert storage format [mention:userId] to display format @username
    const convertToDisplayFormat = useCallback((storageText: string, currentMentions: MentionData[]): string => {
        let result = storageText;
        currentMentions.forEach(mention => {
            const storageMention = `[mention:${mention.userId}]`;
            const displayMention = `@${mention.username}`;
            result = result.replace(new RegExp(storageMention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayMention);
        });
        return result;
    }, []);

    // Handle text change
    const handleTextChange = useCallback((text: string) => {
        // Text from input is in display format (@name)
        // We need to convert to storage format for the parent component
        const storageText = convertToStorageFormat(text, mentions);
        onChangeText(storageText);

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
    }, [cursorPosition, onChangeText, mentions, convertToStorageFormat]);

    // Handle selection change to track cursor position
    const handleSelectionChange = useCallback((event: any) => {
        setCursorPosition(event.nativeEvent.selection.start);
    }, []);

    // Handle user selection from mention picker
    const handleMentionSelect = useCallback((user: MentionUser) => {
        // Convert current storage value to display to find @ position
        const currentDisplayValue = convertToDisplayFormat(value, mentions);
        const textBeforeCursor = currentDisplayValue.substring(0, cursorPosition);
        const textAfterCursor = currentDisplayValue.substring(cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf("@");

        if (lastAtSymbol !== -1) {
            // Store mention metadata first
            const newMention: MentionData = {
                userId: user.id,
                username: user.username,
                displayName: user.name,
            };

            const updatedMentions = [...mentions, newMention];

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
            let storageText = newDisplayText;
            updatedMentions.forEach(mention => {
                const displayMention = `@${mention.username}`;
                const storageMention = `[mention:${mention.userId}]`;
                storageText = storageText.replace(displayMention, storageMention);
            });

            setMentions(updatedMentions);

            // Send storage format to parent
            onChangeText(storageText);

            if (onMentionsChange) {
                onMentionsChange(updatedMentions);
            }

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
    }, [value, cursorPosition, mentions, onChangeText, onMentionsChange, convertToDisplayFormat]);

    const handleClosePicker = useCallback(() => {
        setShowMentionPicker(false);
        setMentionQuery("");
    }, []);

    // Expose imperative methods via ref
    useImperativeHandle(ref, () => ({
        insertTextAtCursor: (text: string) => {
            const displayValue = convertToDisplayFormat(value, mentions);
            const pos = Math.min(cursorPosition, displayValue.length);
            const before = displayValue.substring(0, pos);
            const after = displayValue.substring(pos);
            const newDisplayText = before + text + after;

            // Convert back to storage format
            const storageText = convertToStorageFormat(newDisplayText, mentions);
            onChangeText(storageText);

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
    }), [value, cursorPosition, mentions, onChangeText, convertToDisplayFormat, convertToStorageFormat]);

    // Convert storage format to display format for rendering
    const displayValue = convertToDisplayFormat(value, mentions);

    return (
        <View style={styles.container}>
            <TextInput
                ref={textInputRef}
                value={displayValue}
                onChangeText={handleTextChange}
                onSelectionChange={handleSelectionChange}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.textTertiary}
                maxLength={maxLength}
                multiline={multiline}
                style={[
                    styles.textInput,
                    { color: theme.colors.text },
                    style,
                ]}
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
});

MentionTextInput.displayName = 'MentionTextInput';

const styles = StyleSheet.create({
    container: {
        position: "relative",
    },
    textInput: {
        fontSize: 16,
        textAlignVertical: "top",
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
