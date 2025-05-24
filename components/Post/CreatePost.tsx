import { useOxy } from '@oxyhq/services';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import Avatar from '../Avatar';

interface CreatePostProps {
    onPress?: () => void;
    placeholder?: string;
}

const CreatePost: React.FC<CreatePostProps> = ({
    onPress,
    placeholder
}) => {
    const { t } = useTranslation();
    const { user, isAuthenticated } = useOxy();

    const handlePress = () => {
        if (onPress) {
            onPress();
        } else {
            router.push('/compose');
        }
    };

    if (!isAuthenticated) {
        return null;
    }

    return (
        <TouchableOpacity
            onPress={handlePress}
            style={styles.container}
            activeOpacity={0.7}
        >
            <Avatar
                size={40}
            />
            <View style={styles.inputContainer}>
                <TextInput
                    style={styles.input}
                    placeholder={placeholder || t('What\'s happening?')}
                    placeholderTextColor="#657786"
                    editable={false}
                    pointerEvents="none"
                />
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eff3f4',
    },
    inputContainer: {
        flex: 1,
        marginLeft: 12,
        justifyContent: 'center',
    },
    input: {
        fontSize: 16,
        color: '#14171A',
    },
});

export default CreatePost;
