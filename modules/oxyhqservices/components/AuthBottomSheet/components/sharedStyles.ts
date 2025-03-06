import { StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';

export const sharedStyles = StyleSheet.create({
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
    },
    inputWrapper: {
        width: '100%',
        maxWidth: 400,
        marginBottom: 16,
    },
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
        fontSize: 16,
        fontWeight: '600',
    },
    progressContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 24,
    },
    progressDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: colors.COLOR_BLACK_LIGHT_4,
    },
    progressDotActive: {
        backgroundColor: colors.primaryColor,
    },
    progressDotCompleted: {
        backgroundColor: colors.primaryColor,
    },
    progressLine: {
        width: 24,
        height: 2,
        backgroundColor: colors.COLOR_BLACK_LIGHT_4,
        marginHorizontal: 4,
    },
    progressLineCompleted: {
        backgroundColor: colors.primaryColor,
    },
});