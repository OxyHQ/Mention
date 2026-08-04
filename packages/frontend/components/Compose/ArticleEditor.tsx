import React from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
import { Dialog } from '@oxyhq/bloom/dialog';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from "react-i18next";

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
                    className="text-lg font-bold rounded-[14px] border-[1.5px] border-border bg-muted px-4 py-3 text-foreground"
                    placeholder={t("compose.article.titlePlaceholder", {
                        defaultValue: "Article title",
                    })}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={title}
                    onChangeText={onTitleChange}
                    maxLength={280}
                />

                <TextInput
                    className="min-h-[240px] rounded-[14px] border-[1.5px] border-border bg-muted px-4 py-3 text-[15px] text-foreground"
                    style={{ textAlignVertical: "top" }}
                    placeholder={t("compose.article.bodyPlaceholder", {
                        defaultValue: "Start writing…",
                    })}
                    placeholderTextColor={theme.colors.textSecondary}
                    value={body}
                    onChangeText={onBodyChange}
                    multiline
                />
            </View>
        </Dialog>
    );
};
