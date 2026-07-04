import React, { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { ThemedText } from '@/components/ThemedText';

type BaseWidgetProps = {
    title?: string;
    icon?: ReactNode;
    divider?: boolean;
    children: ReactNode;
};

export function BaseWidget({ title, icon, divider, children }: BaseWidgetProps) {
    return (
        <View
            className={`gap-2${divider ? ' pb-4 border-border' : ''}`}
            style={[styles.base, divider && styles.divider]}
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
    base: {
        pointerEvents: 'auto',
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});
