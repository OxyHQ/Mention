import React from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    Modal,
    KeyboardAvoidingView,
    ScrollView,
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
            <SafeAreaView className="flex-1 bg-background">
                <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
                    <IconButton variant="icon" onPress={onClose} className="mr-1.5 z-[1]">
                        <CloseIcon size={20} className="text-foreground" />
                    </IconButton>
                    <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
                        {t("compose.article.editorTitle", { defaultValue: "Write article" })}
                    </Text>
                    <TouchableOpacity
                        onPress={onSave}
                        className="px-4 py-2 rounded-full bg-primary ml-auto"
                        activeOpacity={0.85}
                    >
                        <Text className="text-sm font-semibold" style={{ color: theme.colors.card }}>
                            {t("common.save")}
                        </Text>
                    </TouchableOpacity>
                </View>

                <KeyboardAvoidingView
                    className="flex-1"
                    behavior={Platform.OS === "ios" ? "padding" : undefined}
                    keyboardVerticalOffset={Platform.OS === "ios" ? 24 : 0}
                >
                    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40, gap: 16 }} keyboardShouldPersistTaps="handled">
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

                        <TextInput
                            className="min-h-[240px] rounded-[14px] border-[1.5px] border-border bg-secondary px-4 py-3 text-[15px] text-foreground"
                            style={{ textAlignVertical: "top" }}
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
