import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState, useRef } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Image
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxyhq/services';
import { usePostsStore } from '../stores/postsStore';
import { colors } from '../styles/colors';

const MAX_CHARACTERS = 280;

const ComposeScreen: React.FC = () => {
    const { user } = useOxy();
    const { createPost } = usePostsStore();
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const textInputRef = useRef<TextInput>(null);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canPost = content.trim().length > 0 && !isOverLimit && !isSubmitting;

    const handlePost = async () => {
        if (!canPost || !user) return;

        setIsSubmitting(true);

        try {
            // Create the post request for the API
            const postRequest = {
                content: {
                    text: content.trim(),
                },
                mentions: [],
                hashtags: []
            };

            // Send to backend API
            await createPost(postRequest);

            // Navigate back
            router.back();

            // Show success feedback
            Alert.alert('Success', 'Your post has been published!');
        } catch (error) {
            console.error('Error posting:', error);
            Alert.alert('Error', 'Failed to publish post. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancel = () => {
        if (content.trim().length > 0) {
            Alert.alert(
                'Discard Post?',
                'You have unsaved changes. Are you sure you want to discard them?',
                [
                    { text: 'Keep Editing', style: 'cancel' },
                    { text: 'Discard', style: 'destructive', onPress: () => router.back() }
                ]
            );
        } else {
            router.back();
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    onPress={handlePost}
                    disabled={!canPost}
                    style={[styles.postButton, !canPost && styles.postButtonDisabled]}
                >
                    <Text style={[styles.postButtonText, !canPost && styles.postButtonTextDisabled]}>
                        Post
                    </Text>
                </TouchableOpacity>
            </View>

            {/* Compose Area */}
            <KeyboardAvoidingView
                style={styles.composeArea}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <View style={styles.userInfo}>
                    <View style={styles.avatarContainer}>
                        <Image
                            source={{ uri: user?.avatar || 'https://via.placeholder.com/40' }}
                            style={styles.avatar}
                        />
                        {user?.verified && (
                            <View style={styles.verifiedBadge}>
                                <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" />
                            </View>
                        )}
                    </View>

                    <View style={styles.userDetails}>
                        <Text style={styles.userName}>{user?.name?.full || user?.username}</Text>
                        <Text style={styles.userHandle}>@{user?.username}</Text>
                    </View>
                </View>

                <TextInput
                    ref={textInputRef}
                    style={styles.textInput}
                    placeholder="What's happening?"
                    placeholderTextColor="#657786"
                    value={content}
                    onChangeText={setContent}
                    multiline
                    autoFocus
                    maxLength={MAX_CHARACTERS}
                    textAlignVertical="top"
                />

                <View style={styles.footer}>
                    <View style={styles.characterCount}>
                        <Text style={[
                            styles.characterCountText,
                            isOverLimit && styles.characterCountWarning
                        ]}>
                            {characterCount}/{MAX_CHARACTERS}
                        </Text>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    cancelButton: {
        padding: 8,
    },
    cancelText: {
        fontSize: 16,
        color: colors.primaryColor,
    },
    postButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
        minWidth: 60,
        alignItems: 'center',
    },
    postButtonDisabled: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_5,
    },
    postButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },
    postButtonTextDisabled: {
        color: '#FFFFFF',
        opacity: 0.7,
    },
    composeArea: {
        flex: 1,
        padding: 16,
    },
    userInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    avatarContainer: {
        position: 'relative',
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    verifiedBadge: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
        borderRadius: 8,
    },
    userDetails: {
        marginLeft: 12,
    },
    userName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    userHandle: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 2,
    },
    textInput: {
        flex: 1,
        fontSize: 18,
        lineHeight: 24,
        color: colors.COLOR_BLACK_LIGHT_1,
        minHeight: 120,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        marginTop: 16,
    },
    characterCount: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    characterCountText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    characterCountWarning: {
        color: '#E0245E',
        fontWeight: '600',
    },
});

export default ComposeScreen; 