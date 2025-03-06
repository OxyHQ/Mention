import { StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';

export const styles = StyleSheet.create({
    formWrapper: {
        flex: 1,
    },
    buttonContainer: {
        paddingVertical: 16,
        flexDirection: 'row',
        alignItems: 'center',
    },
    fullWidthButton: {
        flex: 1,
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
    progressWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
    },
});