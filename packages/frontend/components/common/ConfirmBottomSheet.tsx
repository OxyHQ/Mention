import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
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
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            {/* Header */}
            <View style={[styles.header, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }]}>
                <IconButton variant="icon" 
                    onPress={onCancel}
                    style={styles.closeButton}
                >
                    <CloseIcon size={20} color={theme.colors.text} />
                </IconButton>
                <Text style={[styles.title, { color: theme.colors.text }, { pointerEvents: 'none' }]}>
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

                {/* Buttons */}
                <View style={styles.buttons}>
                    <TouchableOpacity
                        style={[
                            styles.button,
                            styles.cancelButton,
                            { 
                                backgroundColor: theme.colors.card,
                                borderColor: theme.colors.border 
                            }
                        ]}
                        onPress={onCancel}
                        activeOpacity={0.7}
                    >
                        <Text style={[styles.cancelButtonText, { color: theme.colors.text }]}>
                            {cancelText || t('common.cancel')}
                        </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[
                            styles.button,
                            styles.confirmButton,
                            { 
                                backgroundColor: destructive ? theme.colors.error : theme.colors.primary 
                            }
                        ]}
                        onPress={handleConfirm}
                        activeOpacity={0.7}
                    >
                        <Text style={[styles.confirmButtonText, { color: '#FFFFFF' }]}>
                            {confirmText || t('common.confirm')}
                        </Text>
                    </TouchableOpacity>
                </View>
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
    buttons: {
        flexDirection: 'row',
        gap: 12,
    },
    button: {
        flex: 1,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 50,
    },
    cancelButton: {
        borderWidth: 1,
    },
    confirmButton: {
        // backgroundColor set inline
    },
    cancelButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    confirmButtonText: {
        fontSize: 16,
        fontWeight: '600',
        color: '#FFFFFF',
    },
});

export default ConfirmBottomSheet;

