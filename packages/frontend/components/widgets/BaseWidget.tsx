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
            className="bg-card border-border"
            style={styles.widgetContainer}
        >
            {title && (
                <View style={styles.widgetHeader}>
                    <ThemedText style={styles.widgetTitle}>{title}</ThemedText>
                    {icon && <View>{icon}</View>}
                </View>
            )}
            <View style={[styles.widgetContent, noPadding && styles.noPadding]}>{children}</View>
        </View>
    );
}

const styles = StyleSheet.create({
    widgetContainer: {
        borderRadius: 16,
        overflow: 'hidden',
        pointerEvents: 'auto',
        borderWidth: StyleSheet.hairlineWidth,
    },
    widgetHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 4,
    },
    widgetTitle: {
        fontSize: 17,
        fontWeight: 'bold',
    },
    widgetContent: {
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    noPadding: {
        paddingHorizontal: 0,
        paddingBottom: 4,
    },
});
