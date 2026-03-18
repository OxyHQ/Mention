import React, { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from '@/components/ThemedText';

type BaseWidgetProps = {
    title?: string;
    icon?: ReactNode;
    children: ReactNode;
    noPadding?: boolean;
};

export function BaseWidget({ title, icon, children, noPadding = false }: BaseWidgetProps) {
    return (
        <View
            className="bg-card border-border rounded-2xl overflow-hidden"
            style={styles.hairlineBorder}
        >
            {title && (
                <View className="flex-row justify-between items-center px-3 pt-3 pb-1">
                    <ThemedText className="text-[15px] font-bold">{title}</ThemedText>
                    {icon && <View>{icon}</View>}
                </View>
            )}
            <View className={noPadding ? "pb-1" : "px-3 pb-1"}>{children}</View>
        </View>
    );
}

const styles = StyleSheet.create({
    hairlineBorder: {
        borderWidth: StyleSheet.hairlineWidth,
        pointerEvents: 'auto',
    },
});
