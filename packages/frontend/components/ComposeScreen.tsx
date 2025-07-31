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

const MAX_CHARACTERS = 280;

const ComposeScreen: React.FC = () => {
    const { user } = useOxy();
    const { addPost, createPostAPI } = usePostsStore();
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
            await createPostAPI(postRequest);

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
                'Are you sure you want to discard this post?',
                [
                    { text: 'Keep Editing', style: 'cancel' },
                    {
                        text: 'Discard',
                        style: 'destructive',
                        onPress: () => router.back()
                    },
                ]
            );
        } else {
            router.back();
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {/* Header */}
            <View style={[styles.header, { paddingTop: insets.top }]}>
                <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>

                <View style={styles.headerActions}>
                    <TouchableOpacity
                        style={[styles.postButton, !canPost && styles.postButtonDisabled]}
                        onPress={handlePost}
                        disabled={!canPost}
                    >
                        <Text style={[styles.postButtonText, !canPost && styles.postButtonTextDisabled]}>
                            {isSubmitting ? 'Posting...' : 'Post'}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                {/* User Info */}
                <View style={styles.userInfo}>
                    <Image
                        source={{
                            uri: typeof user?.avatar === 'string'
                                ? user.avatar
                                : user?.avatar?.url || 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg'
                        }}
                        style={styles.userAvatar}
                    />
                    <View style={styles.userDetails}>
                        <Text style={styles.userName}>
                            {user?.name?.full || user?.username}
                        </Text>
                        <Text style={styles.userHandle}>@{user?.username}</Text>
                    </View>
                </View>

                {/* Text Input */}
                <TextInput
                    ref={textInputRef}
                    style={styles.textInput}
                    placeholder="What's happening?"
                    placeholderTextColor="#71767B"
                    value={content}
                    onChangeText={setContent}
                    multiline
                    autoFocus
                    maxLength={MAX_CHARACTERS + 50} // Allow some overflow for visual feedback
                    textAlignVertical="top"
                />

                {/* Character Count */}
                <View style={styles.characterCount}>
                    <Text style={[
                        styles.characterCountText,
                        isOverLimit && styles.characterCountOverLimit
                    ]}>
                        {characterCount}
                    </Text>
                    <Text style={styles.characterCountMax}>/{MAX_CHARACTERS}</Text>
                </View>
            </ScrollView>

            {/* Bottom Actions */}
            <View style={styles.bottomActions}>
                <View style={styles.actionButtons}>
                    <TouchableOpacity style={styles.actionButton}>
                        <Ionicons name="image-outline" size={24} color="#1D9BF0" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton}>
                        <Ionicons name="camera-outline" size={24} color="#1D9BF0" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton}>
                        <Ionicons name="videocam-outline" size={24} color="#1D9BF0" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton}>
                        <Ionicons name="location-outline" size={24} color="#1D9BF0" />
                    </TouchableOpacity>
                </View>
            </View>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    cancelButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    cancelText: {
        color: '#1D9BF0',
        fontSize: 16,
        fontWeight: '600',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    postButton: {
        backgroundColor: '#1D9BF0',
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
    },
    postButtonDisabled: {
        backgroundColor: '#1D9BF0',
        opacity: 0.5,
    },
    postButtonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: '700',
    },
    postButtonTextDisabled: {
        opacity: 0.7,
    },
    content: {
        flex: 1,
        paddingHorizontal: 16,
    },
    userInfo: {
        flexDirection: 'row',
        marginTop: 16,
        marginBottom: 12,
    },
    userAvatar: {
        width: 48,
        height: 48,
        borderRadius: 24,
        marginRight: 12,
    },
    userDetails: {
        justifyContent: 'center',
    },
    userName: {
        fontSize: 16,
        fontWeight: '700',
        color: '#FFF',
        marginBottom: 2,
    },
    userHandle: {
        fontSize: 14,
        color: '#71767B',
    },
    textInput: {
        fontSize: 20,
        color: '#FFF',
        lineHeight: 28,
        minHeight: 120,
        textAlignVertical: 'top',
    },
    characterCount: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        marginTop: 16,
        marginBottom: 20,
    },
    characterCountText: {
        fontSize: 14,
        color: '#71767B',
        fontWeight: '500',
    },
    characterCountOverLimit: {
        color: '#F4212E',
    },
    characterCountMax: {
        fontSize: 14,
        color: '#71767B',
        marginLeft: 2,
    },
    bottomActions: {
        paddingHorizontal: 16,
        paddingBottom: 20,
        borderTopWidth: 1,
        borderTopColor: '#2F3336',
    },
    actionButtons: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 12,
    },
    actionButton: {
        padding: 8,
        marginRight: 16,
    },
});

export default ComposeScreen; 