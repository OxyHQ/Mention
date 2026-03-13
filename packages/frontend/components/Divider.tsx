import React from 'react';
import { View, ViewStyle } from 'react-native';
import { cn } from '@/lib/utils';

interface DividerProps {
    style?: ViewStyle;
    className?: string;
}

export function Divider({ style, className }: DividerProps) {
    return (
        <View
            className={cn("w-full border-t border-border", className)}
            style={style}
        />
    );
}

