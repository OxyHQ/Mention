import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff'
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center'
    },
    content: {
        flex: 1,
        padding: 16
    },
    section: {
        marginBottom: 24
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 16
    },
    settingItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0'
    },
    settingLabel: {
        fontSize: 16
    },
    adFreeBanner: {
        backgroundColor: '#f8f9fa',
        padding: 16,
        borderRadius: 8,
        marginTop: 24,
        marginBottom: 24
    },
    adFreeBannerText: {
        textAlign: 'center',
        color: '#6c757d',
        fontSize: 14
    }
});