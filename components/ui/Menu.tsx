import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/styles/colors';

interface MenuItem {
    label: string;
    icon?: string;
    onPress: () => void;
}

interface MenuProps {
    trigger: React.ReactElement;
    items: MenuItem[];
}

export const Menu: React.FC<MenuProps> = ({ trigger, items }) => {
    const [isOpen, setIsOpen] = React.useState(false);

    const handlePress = (item: MenuItem) => {
        setIsOpen(false);
        item.onPress();
    };

    return (
        <View style={styles.container}>
            <Pressable onPress={() => setIsOpen(!isOpen)}>
                {trigger}
            </Pressable>
            
            {isOpen && (
                <>
                    <Pressable style={styles.overlay} onPress={() => setIsOpen(false)} />
                    <BlurView intensity={10} style={styles.menu}>
                        {items.map((item, index) => (
                            <Pressable
                                key={index}
                                style={styles.menuItem}
                                onPress={() => handlePress(item)}
                            >
                                {item.icon && (
                                    <Ionicons 
                                        name={item.icon as any} 
                                        size={20} 
                                        color={colors.primaryDark}
                                        style={styles.menuIcon}
                                    />
                                )}
                                <Text style={styles.menuText}>{item.label}</Text>
                            </Pressable>
                        ))}
                    </BlurView>
                </>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'relative',
    },
    overlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        zIndex: 1,
    },
    menu: {
        position: 'absolute',
        top: '100%',
        right: 0,
        minWidth: 200,
        backgroundColor: colors.primaryLight,
        borderRadius: 12,
        padding: 8,
        zIndex: 2,
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 5,
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
    },
    menuIcon: {
        marginRight: 12,
    },
    menuText: {
        fontSize: 16,
        color: colors.primaryDark,
    },
});