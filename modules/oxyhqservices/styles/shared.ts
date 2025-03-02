import { StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';

export const sharedStyles = StyleSheet.create({
    // Form elements
    input: {
        width: '100%',
        height: 56,
        paddingHorizontal: 20,
        borderWidth: 1.5,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 28,
        color: colors.COLOR_BLACK,
        backgroundColor: colors.primaryLight_1,
        fontSize: 16,
        boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.05)',
        elevation: 2,
    },
    inputWrapper: {
        width: '100%',
        maxWidth: 400,
        marginBottom: 16,
    },

    // Buttons
    button: {
        height: 56,
        borderRadius: 28,
        overflow: 'hidden',
        boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.2)',
        elevation: 4,
    },
    buttonGradient: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    buttonText: {
        color: colors.primaryLight,
        fontWeight: '600',
        fontSize: 17,
    },
    buttonOutline: {
        height: 56,
        paddingHorizontal: 24,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 28,
        borderWidth: 1.5,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.primaryLight_1,
    },
    buttonOutlineText: {
        color: colors.COLOR_BLACK,
        fontWeight: '600',
        fontSize: 17,
    },

    // Typography
    title: {
        fontSize: 28,
        fontWeight: 'bold',
        marginBottom: 16,
        textAlign: 'center',
        color: colors.COLOR_BLACK,
    },
    subtitle: {
        fontSize: 17,
        textAlign: 'center',
        marginBottom: 32,
        color: colors.COLOR_BLACK_LIGHT_4,
        lineHeight: 24,
    },

    // Lists
    listItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    listItemText: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.COLOR_BLACK,
    },
    listItemSubtext: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },

    // Layout
    container: {
        flex: 1,
        width: '100%',
        paddingHorizontal: 16,
        gap: 16,
    },
    content: {
        width: '100%',
        alignItems: 'center',
        paddingVertical: 20,
        maxWidth: 400,
        alignSelf: 'center',
    },

    // Progress indicators
    progressContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 32,
        paddingHorizontal: 20,
    },
    progressDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        borderWidth: 2,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    progressDotActive: {
        backgroundColor: colors.primaryColor,
        borderColor: colors.primaryColor,
        transform: [{ scale: 1.2 }],
    },
    progressDotCompleted: {
        backgroundColor: colors.primaryColor,
        borderColor: colors.primaryColor,
    },
    progressLine: {
        flex: 1,
        height: 2,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        marginHorizontal: 4,
    },
    progressLineCompleted: {
        backgroundColor: colors.primaryColor,
    },
});