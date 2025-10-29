import React, { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { colors } from '@/styles/colors';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

type BaseWidgetProps = {
    title?: string;
    icon?: ReactNode;
    children: ReactNode;
    noPadding?: boolean;
};

export function BaseWidget({ title, icon, children, noPadding = false }: BaseWidgetProps) {
    const theme = useTheme();

    return (
        <View style={[
            styles.widgetContainer,
            {
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.border,
            }
        ]}>
            {title && (
                <View style={[
                    styles.widgetHeader,
                    { borderBottomColor: theme.colors.border }
                ]}>
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
        backgroundColor: "#FFFFFF",
        borderRadius: 15,
        overflow: 'hidden',
        pointerEvents: 'auto' as any,
        borderWidth: 1,
        borderColor: "#EFF3F4",
    },
    widgetHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: "#EFF3F4",
        margin: 15,
        marginBottom: 6,
    },
    widgetTitle: {
        fontSize: 18,
        fontWeight: 'bold',
    },
    widgetContent: {
        padding: 15,
        paddingTop: 0,
    },
    noPadding: {
        padding: 0,
        paddingBottom: 10,
    },
});
