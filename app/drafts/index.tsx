import React from 'react';
import { View } from 'react-native';
import { Header } from '@/components/Header';
import { DraftsAndScheduled } from '@/components/DraftsAndScheduled';
import { Post as IPost } from '@/interfaces/Post';
import { router } from 'expo-router';

export default function DraftsScreen() {
    const handleEditPost = (post: IPost) => {
        // Navigate to edit post screen with the post data
        router.push({
            pathname: '/compose',
            params: {
                draft: JSON.stringify(post)
            }
        });
    };

    return (
        <View style={{ flex: 1, backgroundColor: '#fff' }}>
            <Header options={{ title: 'Drafts & Scheduled' }} />
            <DraftsAndScheduled onEditPost={handleEditPost} />
        </View>
    );
} 