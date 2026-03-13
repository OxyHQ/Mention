import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';

interface MessageBottomSheetProps {
    title: string;
    message?: string;
    okText?: string;
    type?: 'success' | 'error' | 'info';
    onClose: () => void;
}

export const MessageBottomSheet: React.FC<MessageBottomSheetProps> = ({
    title,
    message,
    okText,
    type = 'info',
    onClose,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();

    const getIconColor = () => {
        switch (type) {
            case 'success':
                return theme.colors.success || theme.colors.primary;
            case 'error':
                return theme.colors.error;
            default:
                return theme.colors.primary;
        }
    };

    return (
        <View className="rounded-t-3xl pb-5 bg-background">
            {/* Header */}
            <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border bg-background">
                <IconButton variant="icon"
                    onPress={onClose}
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

                {/* OK Button */}
                <TouchableOpacity
                    className="py-3.5 rounded-xl items-center justify-center min-h-[50px]"
                    style={{ backgroundColor: getIconColor() }}
                    onPress={onClose}
                    activeOpacity={0.7}
                >
                    <Text className="text-base font-semibold text-white">
                        {okText || t('common.ok')}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

export default MessageBottomSheet;
