import React, { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';

type BaseWidgetProps = {
    title?: string;
    icon?: ReactNode;
    divider?: boolean;
    children: ReactNode;
};

export function BaseWidget({ title, icon, divider, children }: BaseWidgetProps) {
    return (
        // The gap BELOW a widget belongs to the widget, not to the column that
        // holds it: a flex `gap` is charged per child regardless of the child's
        // height, so a rail whose widgets have all hidden themselves would still
        // reserve the spacing between them. Owning the margin here lets the
        // column collapse to nothing when every widget renders null.
        <View
            className={`gap-2 mb-4${divider ? ' pb-4 border-border' : ''}`}
            style={[styles.base, divider && styles.divider]}
        >
            {title && (
                <View className="flex-row justify-between items-center">
                    <Text className="text-[15px] leading-6 font-bold text-foreground">{title}</Text>
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
