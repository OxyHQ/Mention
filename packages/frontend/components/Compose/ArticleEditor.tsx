import React from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    Modal,
    KeyboardAvoidingView,
    ScrollView,
    StyleSheet,
    Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from "@/assets/icons/close-icon";

interface ArticleEditorProps {
    visible: boolean;
    title: string;
    body: string;
    onTitleChange: (title: string) => void;
    onBodyChange: (body: string) => void;
    onSave: () => void;
    onClose: () => void;
}

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

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="fullScreen"
            onRequestClose={onClose}
        >
            <SafeAreaView
                style={[styles.container, { backgroundColor: theme.colors.background }]}
            >
                <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                    <IconButton variant="icon" onPress={onClose} style={styles.closeButton}>
                        <CloseIcon size={20} color={theme.colors.text} />
                    </IconButton>
                    <Text style={[styles.headerTitle, { color: theme.colors.text }, { pointerEvents: 'none' }]}>
                        {t("compose.article.editorTitle", { defaultValue: "Write article" })}
                    </Text>
                    <TouchableOpacity
                        onPress={onSave}
                        style={[styles.saveButton, { backgroundColor: theme.colors.primary }]}
                        activeOpacity={0.85}
                    >
                        <Text style={[styles.saveText, { color: theme.colors.card }]}>
                            {t("common.save")}
                        </Text>
                    </TouchableOpacity>
                </View>

                <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                    keyboardVerticalOffset={Platform.OS === "ios" ? 24 : 0}
                >
                    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                        <TextInput
                            style={[
                                styles.titleInput,
                                {
                                    color: theme.colors.text,
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
                            placeholder={t("compose.article.titlePlaceholder", {
                                defaultValue: "Article title",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={title}
                            onChangeText={onTitleChange}
                            maxLength={280}
                        />

                        <TextInput
                            style={[
                                styles.bodyInput,
                                {
                                    color: theme.colors.text,
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
                            placeholder={t("compose.article.bodyPlaceholder", {
                                defaultValue: "Start writing…",
                            })}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={body}
                            onChangeText={onBodyChange}
                            multiline
                        />
                    </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingVertical: 8,
        minHeight: 48,
        borderBottomWidth: 1,
    },
    closeButton: {
        marginRight: 6,
        zIndex: 1,
    },
    headerTitle: {
        position: "absolute",
        left: 0,
        right: 0,
        textAlign: "center",
        fontSize: 18,
        fontWeight: "700",
        pointerEvents: "none",
    },
    saveButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 999,
        marginLeft: "auto",
    },
    saveText: {
        fontSize: 14,
        fontWeight: "600",
    },
    content: {
        paddingHorizontal: 20,
        paddingTop: 24,
        paddingBottom: 40,
        gap: 16,
    },
    titleInput: {
        fontSize: 18,
        fontWeight: "700",
        borderRadius: 14,
        borderWidth: 1.5,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    bodyInput: {
        minHeight: 240,
        borderRadius: 14,
        borderWidth: 1.5,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 15,
        textAlignVertical: "top",
    },
});
