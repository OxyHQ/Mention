import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { cn } from '@/lib/utils';

interface SegmentedControlItem<T extends string> {
    label: string;
    value: T;
}

interface SegmentedControlProps<T extends string> {
    items: SegmentedControlItem<T>[];
    value: T;
    onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
    items,
    value,
    onChange,
}: SegmentedControlProps<T>) {
    return (
        <View className="flex-row rounded-lg bg-muted p-1">
            {items.map((item) => {
                const isSelected = item.value === value;
                return (
                    <Pressable
                        key={item.value}
                        className={cn(
                            'flex-1 py-2 rounded-md items-center justify-center',
                            isSelected && 'bg-card shadow-sm',
                        )}
                        onPress={() => onChange(item.value)}
                    >
                        <Text
                            className={cn(
                                'text-[14px]',
                                isSelected
                                    ? 'font-semibold text-foreground'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {item.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
