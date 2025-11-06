import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { HeaderIconButton } from '@/components/HeaderIconButton';

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
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            {/* Header */}
            <View style={[styles.header, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }]}>
                <HeaderIconButton 
                    onPress={onClose}
                    style={styles.closeButton}
                >
                    <CloseIcon size={20} color={theme.colors.text} />
                </HeaderIconButton>
                <Text style={[styles.title, { color: theme.colors.text }]} pointerEvents="none">
                    {title}
                </Text>
                <View style={styles.headerRight} />
            </View>

            {/* Content */}
            <View style={styles.content}>
                {message && (
                    <Text style={[styles.message, { color: theme.colors.textSecondary }]}>
                        {message}
                    </Text>
                )}

                {/* OK Button */}
                <TouchableOpacity
                    style={[
                        styles.button,
                        { 
                            backgroundColor: getIconColor()
                        }
                    ]}
                    onPress={onClose}
                    activeOpacity={0.7}
                >
                    <Text style={[styles.buttonText, { color: '#FFFFFF' }]}>
                        {okText || t('common.ok')}
                    </Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        paddingBottom: 20,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        minHeight: 48,
        borderBottomWidth: 1,
    },
    title: {
        position: 'absolute',
        left: 0,
        right: 0,
        textAlign: 'center',
        fontSize: 18,
        fontWeight: '700',
        pointerEvents: 'none',
    },
    closeButton: {
        marginRight: 6,
        zIndex: 1,
    },
    headerRight: {
        width: 36,
        marginLeft: 'auto',
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 24,
    },
    message: {
        fontSize: 16,
        lineHeight: 22,
        textAlign: 'center',
        marginBottom: 24,
    },
    button: {
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 50,
    },
    buttonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
});

export default MessageBottomSheet;

