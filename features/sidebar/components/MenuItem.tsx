import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from "@expo/vector-icons";

interface MenuItemProps {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    expanded: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, expanded }) => {
    return (
        <TouchableOpacity style={styles.menuItem}>
            <Ionicons name={icon} size={26} color="#1da1f2" />
            {expanded && <Text style={styles.menuText}>{label}</Text>}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 10,
        borderRadius: 50,
    },
    menuText: {
        marginLeft: 20,
        fontSize: 19,
        fontWeight: 'bold',
    },
});

export default MenuItem;