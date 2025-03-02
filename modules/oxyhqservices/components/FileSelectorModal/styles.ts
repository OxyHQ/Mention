import { StyleSheet, Platform, ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

// Memoize styles to prevent recalculation
export const fileItemStyles = StyleSheet.create({
    container: {
        width: '48%',
        aspectRatio: 1,
        margin: '1%',
        borderRadius: 20,
        overflow: "hidden",
        position: "relative",
        borderWidth: 2,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    selected: {
        borderColor: colors.primaryColor,
        boxShadow: '0px 0px 8px rgba(0, 0, 0, 0.3)',
        elevation: 5,
    },
    preview: {
        width: "100%",
        height: "100%",
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    overlay: {
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        padding: 8,
    },
    fileName: {
        color: "white",
        fontSize: 12,
        textAlign: "center",
        paddingHorizontal: 5,
    },
    indicator: {
        position: "absolute",
        backgroundColor: colors.primaryColor,
        borderRadius: 12,
        padding: 4,
    },
    checkmark: {
        top: 10,
        right: 10,
    },
    fileInfo: {
        top: 10,
        left: 10,
        backgroundColor: 'rgba(0,0,0,0.7)',
    },
    fileInfoText: {
        color: 'white',
        fontSize: 10,
    },
    touchable: {
        flex: 1,
    },
    loadingOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        justifyContent: 'center',
        alignItems: 'center',
    },
});

export const modalStyles = StyleSheet.create({
    background: {
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: colors.overlay,
    },
    container: {
        maxWidth: 900,
        width: "90%",
        height: "90%",
        backgroundColor: colors.primaryLight,
        borderRadius: 35,
        overflow: "hidden",
        elevation: 5,
        boxShadow: '0px 2px 3.84px rgba(0, 0, 0, 0.25)',
    },
});

export const gridStyles = StyleSheet.create({
    container: {
        padding: 10,
    },
    empty: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
        marginTop: 10,
    },
});

export const controlStyles = StyleSheet.create({
    filterContainer: {
        padding: 15,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    input: {
        height: 40,
        backgroundColor: colors.primaryLight,
        borderRadius: 20,
        paddingHorizontal: 15,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    buttonsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        padding: 15,
        borderTopWidth: 1,
        borderTopColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.primaryLight,
    },
    button: {
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderRadius: 20,
        minWidth: 100,
        alignItems: 'center',
    },
    buttonCancel: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    buttonDone: {
        backgroundColor: colors.primaryColor,
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    buttonText: {
        fontWeight: '600',
    },
    buttonTextCancel: {
        color: colors.COLOR_BLACK,
    },
    buttonTextDone: {
        color: colors.primaryLight,
    },
    uploadButton: {
        position: 'absolute',
        bottom: 90,
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 5,
        boxShadow: '0px 2px 3.84px rgba(0, 0, 0, 0.25)',
    },
    shortcutHint: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
        marginTop: 4,
    },
});