import React from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
// Imported from the COMPONENT module, not the package barrel. The barrel also
// re-exports `parseExpensiMark`, and Metro bundles a module's whole static
// import graph — so the bare specifier drags `expensify-common` (jQuery,
// localforage, a git-sourced `simply-deferred`) into the compose chunk even
// though nothing calls it. Measured on a production `expo export`: the barrel
// import put `ExpensiMark`, `jquery` and `localforage` in the shipped bundle;
// this one does not.
import MarkdownTextInput, { type MarkdownStyle } from '@expensify/react-native-live-markdown/src/MarkdownTextInput';
import { Dialog } from '@oxyhq/bloom/dialog';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from "react-i18next";
import { parseArticleMarkdown } from '@/utils/markdownRanges';

interface ArticleEditorProps {
    visible: boolean;
    title: string;
    body: string;
    onTitleChange: (title: string) => void;
    onBodyChange: (body: string) => void;
    onSave: () => void;
    onClose: () => void;
}

/**
 * The long-form writing surface behind the composer's "article" attachment.
 *
 * It renders through bloom's `Dialog`, NOT a hand-rolled RN `<Modal>`. That is a
 * layering decision rather than a styling one: a raw `Modal` gets its own native
 * window, which sits outside any ordering the design system can apply, so an
 * overlay opened from inside it — a confirm prompt, a picker — has no way to
 * paint above it. Everything on bloom's surface stack orders against everything
 * else; a bare `Modal` orders against nothing.
 *
 * The Dialog also owns what this component used to hand-roll: the safe-area
 * insets, the keyboard-avoiding behaviour while a long body is being typed, the
 * scroll container, and the header with its close affordance. `placement` is the
 * app's usual dialog-to-sheet pair — a near-full-height sheet on a phone, where
 * that is the native shape for a writing surface, and a wide centered card on a
 * desktop, where prose reads better than a 460px drawer.
 *
 * The body is a LIVE markdown surface (`MarkdownTextInput` from
 * `@expensify/react-native-live-markdown`): headings, emphasis, code, quotes and
 * links format as they are typed. It edits the SAME plain string as before —
 * markdown is a way of reading the text, not a different storage format — so
 * every article already written in the old plain field opens unchanged, and
 * nothing is rewritten on save.
 *
 * Every value is controlled by the composer, which owns the draft: this
 * component holds no copy of the title or body, so opening, typing, closing and
 * reopening cannot lose them.
 */
export const ArticleEditor: React.FC<ArticleEditorProps> = ({
    visible,
    title,
    body,
    onTitleChange,
    onBodyChange,
    onSave,
    onClose,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();

    // Themed from bloom's palette rather than hardcoded, so the editor tracks
    // the reader's colour scheme like every other Mention surface. Memoized
    // because the library re-applies the whole style set whenever this changes.
    const markdownStyle = React.useMemo<MarkdownStyle>(() => ({
        syntax: { color: theme.colors.textTertiary },
        emoji: { fontSize: 20, fontFamily: 'System' },
        link: { color: theme.colors.primary },
        h1: { fontSize: 24 },
        blockquote: {
            borderColor: theme.colors.border,
            borderWidth: 3,
            marginLeft: 0,
            paddingLeft: 10,
        },
        code: {
            fontFamily: 'monospace',
            fontSize: 14,
            color: theme.colors.text,
            backgroundColor: theme.colors.secondary,
        },
        pre: {
            fontFamily: 'monospace',
            fontSize: 14,
            color: theme.colors.text,
            backgroundColor: theme.colors.secondary,
        },
        mentionHere: { color: theme.colors.primary, backgroundColor: 'transparent' },
        mentionUser: { color: theme.colors.primary, backgroundColor: 'transparent' },
        mentionReport: { color: theme.colors.primary, backgroundColor: 'transparent' },
        inlineImage: {
            minWidth: 40,
            minHeight: 40,
            maxWidth: 200,
            maxHeight: 200,
            marginTop: 4,
            marginBottom: 0,
            borderRadius: 8,
        },
    }), [theme]);

    const saveAction = (
        <TouchableOpacity
            onPress={onSave}
            className="px-4 py-2 rounded-full bg-primary"
            activeOpacity={0.85}
            accessibilityRole="button"
        >
            <Text className="text-sm font-semibold" style={{ color: theme.colors.card }}>
                {t("common.save")}
            </Text>
        </TouchableOpacity>
    );

    return (
        <Dialog
            open={visible}
            onClose={onClose}
            placement={{ base: 'bottom', md: 'center' }}
            maxWidth={720}
            maxHeightRatio={0.92}
            header={{
                title: t("compose.article.editorTitle", { defaultValue: "Write article" }),
                largeTitle: false,
                right: saveAction,
            }}
            testID="articleEditorDialog"
        >
            <View className="gap-4 pb-6">
                <TextInput
                    className="text-lg font-bold rounded-[14px] border-[1.5px] border-border bg-secondary px-4 py-3 text-foreground"
                    placeholder={t("compose.article.titlePlaceholder", {
                        defaultValue: "Article title",
                    })}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={title}
                    onChangeText={onTitleChange}
                    maxLength={280}
                />

                <MarkdownTextInput
                    className="min-h-[240px] rounded-[14px] border-[1.5px] border-border bg-secondary px-4 py-3 text-[15px] text-foreground"
                    style={{ textAlignVertical: "top" }}
                    placeholder={t("compose.article.bodyPlaceholder", {
                        defaultValue: "Start writing in markdown…",
                    })}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={body}
                    onChangeText={onBodyChange}
                    parser={parseArticleMarkdown}
                    markdownStyle={markdownStyle}
                    multiline
                    testID="articleBodyInput"
                />
            </View>
        </Dialog>
    );
};
