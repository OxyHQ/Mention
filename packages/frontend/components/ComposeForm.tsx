import React from 'react';
import { View, TextInput, TouchableOpacity } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Ionicons } from '@expo/vector-icons';

interface Props {
    id: string | number;
    value: string;
    onChange: (v: string) => void;
    onRemove?: () => void;
    placeholder?: string;
    showAvatar?: boolean;
    avatarSrc?: string | undefined;
}

const ComposeForm: React.FC<Props> = ({ id, value, onChange, onRemove, placeholder, showAvatar = true, avatarSrc }) => {
    return (
        <View className="flex-row items-start px-4 gap-3" key={id}>
            <View className="w-12 items-center">
                <View className="w-0.5 h-2 rounded-sm bg-primary" />
                {showAvatar && <Avatar source={avatarSrc ? { uri: avatarSrc } : undefined} size={36} />}
                <View className="w-0.5 flex-1 rounded-sm min-h-[16px] bg-primary" />
            </View>

            <View className="flex-1">
                <TextInput
                    className="min-h-[64px] text-base text-foreground"
                    placeholder={placeholder || "What's happening?"}
                    placeholderTextColor="#949494"
                    value={value}
                    onChangeText={onChange}
                    multiline
                />

                {/* toolbar under each form */}
                <View className="flex-row gap-3.5 mt-2">
                    <TouchableOpacity>
                        <Ionicons name="image-outline" size={18} color="#5e5e5e" />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="gift" size={18} color="#5e5e5e" />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="happy-outline" size={18} color="#5e5e5e" />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="list-outline" size={18} color="#5e5e5e" />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="document-text-outline" size={18} color="#5e5e5e" />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="location-outline" size={18} color="#5e5e5e" />
                    </TouchableOpacity>
                </View>
            </View>

            {onRemove && (
                <TouchableOpacity onPress={onRemove} className="p-1.5">
                    <Ionicons name="close" size={18} color="#5e5e5e" />
                </TouchableOpacity>
            )}
        </View>
    );
};

export default ComposeForm;
