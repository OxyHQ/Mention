import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';

interface ConfirmBottomSheetProps {
    title: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    destructive?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export const ConfirmBottomSheet: React.FC<ConfirmBottomSheetProps> = ({
    title,
    message,
    confirmText,
    cancelText,
    destructive = false,
    onConfirm,
    onCancel,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();

    const handleConfirm = () => {
        onConfirm();
        onCancel(); // Close the sheet
    };

    return (
        <View className="rounded-t-3xl pb-5 bg-background">
            {/* Header */}
            <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border bg-background">
                <IconButton variant="icon"
                    onPress={onCancel}
                    className="mr-1.5 z-[1]"
                >
                    <CloseIcon size={20} className="text-foreground" />
                </IconButton>
                <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none">
                    {title}
                </Text>
                <View className="w-9 ml-auto" />
            </View>

            {/* Content */}
            <View className="px-4 pt-6">
                {message && (
                    <Text className="text-base text-center text-muted-foreground mb-6" style={{ lineHeight: 22 }}>
                        {message}
                    </Text>
                )}

                {/* Buttons */}
                <View className="flex-row gap-3">
                    <TouchableOpacity
                        className="flex-1 py-3.5 rounded-xl items-center justify-center min-h-[50px] border border-border"
                        style={{ backgroundColor: theme.colors.card }}
                        onPress={onCancel}
                        activeOpacity={0.7}
                    >
                        <Text className="text-base font-semibold text-foreground">
                            {cancelText || t('common.cancel')}
                        </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        className="flex-1 py-3.5 rounded-xl items-center justify-center min-h-[50px]"
                        style={{
                            backgroundColor: destructive ? theme.colors.error : theme.colors.primary
                        }}
                        onPress={handleConfirm}
                        activeOpacity={0.7}
                    >
                        <Text className="text-base font-semibold text-white">
                            {confirmText || t('common.confirm')}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    );
};

export default ConfirmBottomSheet;
