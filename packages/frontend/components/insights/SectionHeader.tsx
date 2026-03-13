import React from 'react';
import { View, Text } from 'react-native';

interface SectionHeaderProps {
    icon?: string;
    title: string;
    iconColor?: string;
    titleColor?: string;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
    title,
    titleColor,
}) => {
    return (
        <View className="flex-row items-center mb-3">
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
