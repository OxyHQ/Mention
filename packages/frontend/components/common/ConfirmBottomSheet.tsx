import React from 'react';
import { View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

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
    const { t } = useTranslation();

    const handleConfirm = () => {
        onConfirm();
        onCancel(); // Close the sheet
    };

    return (
        <View className="rounded-t-3xl pb-5 bg-background">
            {/* Header */}
            <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border bg-background">
                <Button
                    appearance="subtle" tone="neutral"
                    iconOnly
                    leadingIcon={RiCloseLine}
                    accessibilityLabel={t('common.close')}
                    onPress={onCancel}
                    className="mr-1.5 z-[1]"
                />
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
                    <Button
                        appearance="subtle" tone="neutral"
                        size="large"
                        className="flex-1"
                        onPress={onCancel}
                    >
                        {cancelText || t('common.cancel')}
                    </Button>

                    <Button
                        appearance="solid" tone={destructive ? 'danger' : 'accent'}
                        size="large"
                        className="flex-1"
                        onPress={handleConfirm}
                    >
                        {confirmText || t('common.confirm')}
                    </Button>
                </View>
            </View>
        </View>
    );
};

export default ConfirmBottomSheet;
