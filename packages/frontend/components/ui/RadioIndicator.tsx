import React from 'react';
import { View } from 'react-native';

export function RadioIndicator({ selected }: { selected: boolean }) {
    return (
        <View
            className={`w-5 h-5 rounded-full border-2 items-center justify-center ${
                selected ? 'border-primary bg-primary' : 'border-border'
            }`}
        >
            {selected ? <View className="w-2 h-2 rounded-full bg-white" /> : null}
        </View>
    );
}
