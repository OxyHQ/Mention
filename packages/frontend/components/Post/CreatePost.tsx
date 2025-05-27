import { useOxy } from '@oxyhq/services/full';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, TouchableOpacity, View, Text, Platform } from 'react-native';
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
        <View style={styles.mainContainer}>
            <TouchableOpacity
                onPress={handlePress}
                style={styles.container}
                activeOpacity={0.7}
            >
                <Avatar
                    size={40}
                    imageUrl={user?.avatar}
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
            <TouchableOpacity
                style={styles.postButton}
                onPress={handlePress}
            >
                <Text style={styles.postButtonText}>{t('Create')}</Text>
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    mainContainer: {
        backgroundColor: 'white',
        borderRadius: 8,
        paddingVertical: 12,
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    container: {
        flexDirection: 'row',
        padding: 12,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#F5F8FA',
    },
    inputContainer: {
        flex: 1,
        marginLeft: 12,
        justifyContent: 'center',
        backgroundColor: '#F5F8FA',
        borderRadius: Platform.OS === 'ios' ? 20 : 24,
        paddingHorizontal: 16,
        height: 40,
    },
    input: {
        fontSize: 16,
        color: '#14171A',
    },
    postButton: {
        marginTop: 8,
        backgroundColor: '#1DA1F2',
        borderRadius: 24,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignSelf: 'flex-end',
        marginRight: 16,
    },
    postButtonText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 14,
    },
});

export default CreatePost;
