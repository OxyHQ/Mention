import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";

interface MenuItemProps {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    expanded: boolean;
    route?: string;
    onPress?: () => void;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, expanded, route, onPress }) => {
    return (
        <>
            {route ? (
                <Link href={route as any}>
                    <TouchableOpacity style={[styles.menuItem, { marginHorizontal: expanded ? 0 : 'auto' }]}>
                        <Ionicons name={icon} size={26} color="#1da1f2" />
                        {expanded && <Text style={styles.menuText}>{label}</Text>}
                    </TouchableOpacity>
                </Link>
            ) : (
                <TouchableOpacity style={[styles.menuItem, { marginHorizontal: expanded ? 0 : 'auto' }]} onPress={onPress}>
                    <Ionicons name={icon} size={26} color="#1da1f2" />
                    {expanded && <Text style={styles.menuText}>{label}aaa</Text>}
                </TouchableOpacity>
            )}
        </>
    );
};

const styles = StyleSheet.create({
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 10,
        borderRadius: 50,
        marginHorizontal: 0,
    },
    menuText: {
        marginLeft: 20,
        fontSize: 19,
        fontWeight: 'bold',
    },
});

export default MenuItem;