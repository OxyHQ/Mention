import { StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';

export const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
        paddingHorizontal: 20,
        paddingTop: 20,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        marginBottom: 8,
        borderRadius: 8,
        paddingHorizontal: 12,
    },
    itemText: {
        fontSize: 16,
        fontWeight: '500',
        marginLeft: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
}); 