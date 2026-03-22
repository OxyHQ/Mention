import React, { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from '@/components/ThemedText';

type BaseWidgetProps = {
    title?: string;
    icon?: ReactNode;
    children: ReactNode;
};

export function BaseWidget({ title, icon, children }: BaseWidgetProps) {
    return (
        <View
            className="bg-card border-border rounded-2xl overflow-hidden p-4 gap-3"
            style={styles.hairlineBorder}
        >
            {title && (
                <View className="flex-row justify-between items-center">
                    <ThemedText className="text-[15px] font-bold">{title}</ThemedText>
                    {icon && <View>{icon}</View>}
                </View>
            )}
            <View>{children}</View>
        </View>
    );
}

const styles = StyleSheet.create({
    hairlineBorder: {
        borderWidth: StyleSheet.hairlineWidth,
        pointerEvents: 'auto',
    },
});
