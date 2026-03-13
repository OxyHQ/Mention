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
                <View
                    className="border-border"
                    style={styles.widgetHeader}
                >
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
        paddingBottom: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        marginHorizontal: 12,
        marginTop: 12,
        marginBottom: 0,
    },
    widgetTitle: {
        fontSize: 17,
        fontWeight: 'bold',
    },
    widgetContent: {
        paddingHorizontal: 12,
        paddingTop: 0,
        paddingBottom: 8,
    },
    noPadding: {
        paddingHorizontal: 0,
        paddingBottom: 6,
    },
});
