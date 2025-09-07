import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import Avatar from '@/components/Avatar';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/styles/colors';

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
        <View style={styles.row} key={id}>
            <View style={styles.leftCol}>
                <View style={styles.connectorTop} />
                {showAvatar && <Avatar source={avatarSrc ? { uri: avatarSrc } : undefined} size={36} />}
                <View style={styles.connectorBottom} />
            </View>

            <View style={styles.content}>
                <TextInput
                    style={styles.textInput}
                    placeholder={placeholder || "What's happening?"}
                    placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
                    value={value}
                    onChangeText={onChange}
                    multiline
                />

                {/* toolbar under each form */}
                <View style={styles.toolbarRow}>
                    <TouchableOpacity>
                        <Ionicons name="image-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="gift" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="happy-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="list-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="document-text-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                    </TouchableOpacity>
                    <TouchableOpacity>
                        <Ionicons name="location-outline" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                    </TouchableOpacity>
                </View>
            </View>

            {onRemove && (
                <TouchableOpacity onPress={onRemove} style={styles.removeBtn}>
                    <Ionicons name="close" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
                </TouchableOpacity>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: 16,
        gap: 12,
        marginTop: 0,
    },
    leftCol: {
        width: 48,
        alignItems: 'center',
    },
    connectorTop: {
        width: 2,
        height: 8,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 1,
        marginBottom: 0,
    },
    connectorBottom: {
        width: 2,
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        marginTop: 0,
        borderRadius: 1,
        minHeight: 16,
    },
    connector: {
        width: 2,
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        marginTop: 8,
        borderRadius: 1,
    },
    content: {
        flex: 1,
    },
    textInput: {
        minHeight: 64,
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    toolbarRow: {
        flexDirection: 'row',
        gap: 14,
        marginTop: 8,
    },
    removeBtn: {
        padding: 6,
    },
});

export default ComposeForm;
