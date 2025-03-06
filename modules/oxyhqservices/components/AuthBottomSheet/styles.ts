import { StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';

export const sharedStyles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 20,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_2,
        marginBottom: 24,
    },
    inputWrapper: {
        marginBottom: 16,
    },
    input: {
        height: 48,
        backgroundColor: colors.COLOR_BLACK_LIGHT_5,
        borderRadius: 8,
        paddingHorizontal: 16,
        fontSize: 16,
    },
    button: {
        height: 48,
        borderRadius: 8,
        overflow: 'hidden',
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

export const styles = StyleSheet.create({
    formWrapper: {
        flex: 1,
    },
    buttonContainer: {
        paddingVertical: 16,
    },
    fullWidthButton: {
        width: '100%',
    },
    switchModeButton: {
        alignItems: 'center',
        paddingVertical: 12,
    },
    switchModeText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_2,
    },
    switchModeLink: {
        color: colors.primaryColor,
        fontWeight: '600',
    },
    centerContent: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.COLOR_BLACK_LIGHT_5,
        marginBottom: 12,
    },
    sessionInfo: {
        marginLeft: 12,
        flex: 1,
    },
    sessionName: {
        fontSize: 16,
        fontWeight: '600',
    },
    sessionUsername: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_2,
    },
    buttonText: {
        color: colors.primaryLight,
        fontSize: 16,
        fontWeight: '600',
    },
    progressWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
    },
});