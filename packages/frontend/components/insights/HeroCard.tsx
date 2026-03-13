import React from 'react';
import { View, Text } from 'react-native';

interface HeroCardProps {
    value: string | number;
    subtitle?: string;
    subtitleColor?: string;
}

const HeroCard: React.FC<HeroCardProps> = ({
    value,
    subtitle,
    subtitleColor,
}) => {
    return (
        <View className="items-center py-4 mb-2">
            <Text
                className="text-foreground text-4xl font-extrabold"
                style={{ letterSpacing: -0.5 }}
            >
                {value}
            </Text>
            {subtitle && (
                <Text
                    className="text-muted-foreground text-[13px] mt-1 font-medium"
                    style={subtitleColor ? { color: subtitleColor } : undefined}
                >
                    {subtitle}
                </Text>
            )}
        </View>
    );
};

export default HeroCard;
