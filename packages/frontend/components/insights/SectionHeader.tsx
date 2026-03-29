import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface SectionHeaderProps {
    icon?: string;
    title: string;
    iconColor?: string;
    titleColor?: string;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
    icon,
    title,
    iconColor,
    titleColor,
}) => {
    return (
        <View className="flex-row items-center mb-3">
            {icon && (
                <Ionicons
                    name={icon as React.ComponentProps<typeof Ionicons>['name']}
                    size={20}
                    color={iconColor}
                    style={{ marginRight: 8 }}
                />
            )}
            <Text
                className="text-foreground text-lg font-bold"
                style={titleColor ? { color: titleColor } : undefined}
            >
                {title}
            </Text>
        </View>
    );
};

export default SectionHeader;
